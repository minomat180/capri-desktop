// Capri's overlay on macOS: a transparent, click-through panel over the whole screen holding her
// renderer in a WKWebView, plus everything the service needs from the Mac itself (windows, the
// pointer, running apps, the battery, the network, what's plugged in, the music player).
// Started (and restarted) by the service (linux/daemon/main.js); the macOS twin of
// linux/shell/capri-shell.py.
//
// For the page (window.webkit.messageHandlers.capri), the same messages as on Linux:
//   {type: 'interactive', on}  -> catch the pointer (whole overlay) or let it all through
//   {type: 'keyboard', on}     -> take the keyboard while her chat is open, give it back after
//   {type: 'copy', id, rect}   -> PNG of that part of the overlay onto the clipboard
//   {type: 'approval', ...}    -> a vault approval click, to the service over fd 3 only
//
// For the service, JSON lines:
//   stdin  requests   {id, type, ...}            apps, closeApp, menu, media, mediaStatus, cursor, tray
//   fd 4   replies    {type: 'reply', id, value}
//   fd 4   pushes     {type: 'windows' | 'pc' | 'menu', ...}, sent when something changes
//   fd 3   approvals  {type: 'approval', id, decision}: only a real click gets here

import AppKit
import IOKit
import IOKit.ps
import Network
import WebKit

func log(_ items: Any...) {
  print("[capri-shell]", items.map { "\($0)" }.joined(separator: " "))
  fflush(stdout)
}

// ---------- the pipes to the service ----------

final class Pipe {
  private let fd: Int32
  private let open: Bool
  private let queue = DispatchQueue(label: "capri.pipe")

  init(fd: Int32) {
    self.fd = fd
    open = fcntl(fd, F_GETFD) != -1
  }

  func send(_ object: [String: Any]) {
    guard open, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    queue.async { [fd] in
      var line = data
      line.append(0x0A)
      line.withUnsafeBytes { raw in
        var sent = 0
        while sent < raw.count {
          let n = write(fd, raw.baseAddress! + sent, raw.count - sent)
          if n <= 0 { return }
          sent += n
        }
      }
    }
  }
}

let service = Pipe(fd: 4)
let approvals = Pipe(fd: 3)

// ---------- what she can feel of this Mac ----------

func powerChanged(_: UnsafeMutableRawPointer?) {
  DispatchQueue.main.async { Sensors.shared.changed() }
}

func usbChanged(_: UnsafeMutableRawPointer?, iterator: io_iterator_t) {
  // the iterator has to be emptied, or the notification never fires again
  while case let entry = IOIteratorNext(iterator), entry != 0 { IOObjectRelease(entry) }
  DispatchQueue.main.async { Sensors.shared.changed() }
}

// Battery, network, removable drives, USB devices. Nothing is polled: the system says when one
// of them changes, and the service gets the lot again.
final class Sensors {
  static let shared = Sensors()
  private let path = NWPathMonitor()
  private var online = true
  private var last = ""
  private var port: IONotificationPortRef?

  func start() {
    if let source = IOPSNotificationCreateRunLoopSource(powerChanged, nil)?.takeRetainedValue() {
      CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
    }
    path.pathUpdateHandler = { [weak self] p in
      DispatchQueue.main.async {
        self?.online = p.status == .satisfied
        self?.changed()
      }
    }
    path.start(queue: DispatchQueue(label: "capri.network"))
    let center = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.didMountNotification, NSWorkspace.didUnmountNotification] {
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.changed() }
    }
    port = IONotificationPortCreate(kIOMainPortDefault)
    if let port {
      IONotificationPortSetDispatchQueue(port, DispatchQueue(label: "capri.usb"))
      for kind in [kIOFirstMatchNotification, kIOTerminatedNotification] {
        var iterator: io_iterator_t = 0
        if IOServiceAddMatchingNotification(port, kind, IOServiceMatching("IOUSBHostDevice"), usbChanged, nil, &iterator) == KERN_SUCCESS {
          usbChanged(nil, iterator: iterator)
        }
      }
    }
    changed()
  }

  func changed() {
    let state: [String: Any] = [
      "type": "pc", "battery": battery() ?? NSNull(), "online": online, "usb": drives(), "devices": devices(),
    ]
    guard let key = try? JSONSerialization.data(withJSONObject: state, options: .sortedKeys), let text = String(data: key, encoding: .utf8) else { return }
    if text == last { return }
    last = text
    service.send(state)
  }

  // { level: 0-1, charging } or nil on a Mac without a battery
  private func battery() -> [String: Any]? {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return nil }
    for source in list {
      guard let d = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
            d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
            let now = d[kIOPSCurrentCapacityKey] as? Double, let full = d[kIOPSMaxCapacityKey] as? Double, full > 0 else { continue }
      let plugged = d[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue
      return ["level": max(0, min(1, now / full)), "charging": plugged || (d[kIOPSIsChargingKey] as? Bool ?? false)]
    }
    return nil
  }

  // removable volumes that are mounted: [{ id, label, mount }]
  private func drives() -> [[String: Any]] {
    let keys: [URLResourceKey] = [.volumeIsRemovableKey, .volumeIsEjectableKey, .volumeIsInternalKey, .volumeNameKey]
    let urls = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: keys, options: [.skipHiddenVolumes]) ?? []
    return urls.compactMap { url in
      guard let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
      let external = v.volumeIsRemovable == true || v.volumeIsEjectable == true || v.volumeIsInternal == false
      guard external, url.path != "/" else { return nil }
      return ["id": url.path, "label": v.volumeName ?? url.lastPathComponent, "mount": url.path]
    }
  }

  // USB devices now attached: [{ id, name, cls }]
  private func devices() -> [[String: Any]] {
    var iterator: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOUSBHostDevice"), &iterator) == KERN_SUCCESS else { return [] }
    defer { IOObjectRelease(iterator) }
    var out: [[String: Any]] = []
    while case let entry = IOIteratorNext(iterator), entry != 0 {
      defer { IOObjectRelease(entry) }
      let prop = { (key: String) in IORegistryEntryCreateCFProperty(entry, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() }
      guard let name = prop("USB Product Name") as? String ?? prop("kUSBProductString") as? String else { continue }
      let hex = { (key: String) in String(format: "%04x", (prop(key) as? Int) ?? 0) }
      let place = (prop("locationID") as? Int) ?? 0
      out.append([
        "id": "\(hex("idVendor")):\(hex("idProduct")):\(String(place, radix: 16))",
        "name": name,
        "cls": String(format: "%02x", (prop("bDeviceClass") as? Int) ?? 0),
      ])
    }
    return out.sorted { ($0["id"] as! String) < ($1["id"] as! String) }
  }
}

// ---------- the music player: Spotify first, then Music, and only if it's already open ----------

enum Player {
  static let known = [("com.spotify.client", "spotify"), ("com.apple.Music", "music")]
  static let verbs = ["next": "next track", "previous": "previous track", "pause": "pause", "play": "play", "playpause": "playpause"]
  static let queue = DispatchQueue(label: "capri.player")

  static func current() -> (id: String, name: String)? {
    let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
    return known.first { running.contains($0.0) }.map { (id: $0.0, name: $0.1) }
  }

  // AppleScript, off the main thread: the first time, macOS asks whether Capri may control the player
  private static func tell(_ id: String, _ what: String) -> String? {
    var error: NSDictionary?
    let result = NSAppleScript(source: "tell application id \"\(id)\" to \(what)")?.executeAndReturnError(&error)
    if let error { log("player:", error[NSAppleScript.errorMessage] ?? error); return nil }
    return result?.stringValue ?? ""
  }

  private static func track(_ id: String) -> String {
    tell(id, "(artist of current track) & \" – \" & (name of current track)") ?? ""
  }

  static func control(_ action: String, done: @escaping ([String: Any]) -> Void) {
    guard let verb = verbs[action] else { return done(["ok": false, "error": "unknown action"]) }
    guard let p = current() else { return done(["ok": false, "error": "noplayer"]) }
    queue.async {
      guard tell(p.id, verb) != nil else { return done(["ok": false, "error": "failed", "player": p.name]) }
      Thread.sleep(forTimeInterval: 0.7) // the new track's name lands a beat later
      done(["ok": true, "player": p.name, "track": track(p.id)])
    }
  }

  // a spotify: link (the service checks its shape). Spotify has to be up to take it: start it if
  // it isn't, in the background, and give it a moment.
  static func play(_ uri: String, done: @escaping ([String: Any]) -> Void) {
    let id = known[0].0
    let running = { NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == id } }
    let start = {
      queue.async {
        guard tell(id, "play track \"\(uri)\"") != nil else { return done(["ok": false, "error": "spotify"]) }
        Thread.sleep(forTimeInterval: 1.2)
        done(["ok": true, "track": track(id)])
      }
    }
    if running() { return start() }
    guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { return done(["ok": false, "error": "spotify"]) }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = false
    NSWorkspace.shared.openApplication(at: app, configuration: config) { _, error in
      if error != nil { return done(["ok": false, "error": "spotify"]) }
      queue.asyncAfter(deadline: .now() + 3) { start() }
    }
  }

  static func status(done: @escaping (Any) -> Void) {
    guard let p = current() else { return done(NSNull()) }
    queue.async {
      let state = tell(p.id, "player state as string") ?? ""
      done(["player": p.name, "track": track(p.id), "state": state.prefix(1).uppercased() + state.dropFirst()])
    }
  }
}

// ---------- the overlay ----------

final class OverlayPanel: NSPanel {
  var wantsKeyboard = false
  override var canBecomeKey: Bool { wantsKeyboard }
  override var canBecomeMain: Bool { false }
}

final class OverlayView: WKWebView {
  // her own right-click handling only
  override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) { menu.removeAllItems() }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class Shell: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSMenuDelegate {
  let url: URL
  let output: String?
  let icon: String?
  var panel: OverlayPanel!
  var view: OverlayView!
  var statusItem: NSStatusItem?
  var lastWindows = ""
  var windowsTimer: Timer?
  var windowsAt = 0.0
  var cursorAt = 0.0
  var cursorQueued = false

  init(url: URL, output: String?, icon: String?) {
    self.url = url
    self.output = output
    self.icon = icon
  }

  var screen: NSScreen {
    NSScreen.screens.first { $0.localizedName == output } ?? NSScreen.screens.first ?? NSScreen.main!
  }

  // her screen in the coordinates windows and the pointer are reported in (origin top left)
  var bounds: CGRect {
    let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
    return id.map { CGDisplayBounds($0) } ?? CGRect(origin: .zero, size: screen.frame.size)
  }

  // ---------- window ----------

  func applicationDidFinishLaunching(_: Notification) {
    panel = OverlayPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isFloatingPanel = true
    panel.level = .statusBar // over the menu bar and full-screen apps, under menus (set last: floating resets it)
    panel.ignoresMouseEvents = true
    panel.isReleasedWhenClosed = false

    let config = WKWebViewConfiguration()
    config.mediaTypesRequiringUserActionForPlayback = []
    config.userContentController.add(self, name: "capri")
    // her console, in the service's log
    let console = """
    for (const level of ['log', 'warn', 'error']) {
      const real = console[level].bind(console);
      console[level] = (...a) => { real(...a); try { window.webkit.messageHandlers.capri.postMessage({ type: 'console', level, text: a.map(String).join(' ') }); } catch {} };
    }
    window.addEventListener('error', (e) => console.error(e.message, e.filename + ':' + e.lineno));
    """
    config.userContentController.addUserScript(WKUserScript(source: console, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    view = OverlayView(frame: panel.contentLayoutRect, configuration: config)
    view.setValue(false, forKey: "drawsBackground")
    view.navigationDelegate = self
    view.autoresizingMask = [.width, .height]
    view.allowsBackForwardNavigationGestures = false
    panel.contentView = view
    view.load(URLRequest(url: url))
    panel.orderFrontRegardless()

    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.panel.setFrame(self.screen.frame, display: true)
      self.pollWindows()
    }

    startStatusItem()
    startPointer()
    startWindows()
    Sensors.shared.start()
    startRequests()
  }

  func webViewWebContentProcessDidTerminate(_: WKWebView) {
    log("web process died")
    exit(1) // the service restarts us
  }

  func webView(_: WKWebView, didFail _: WKNavigation!, withError error: Error) { log("load failed:", error.localizedDescription) }
  func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
    log("load failed:", error.localizedDescription)
    exit(1)
  }

  // ---------- the page's requests ----------

  func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let msg = message.body as? [String: Any], let kind = msg["type"] as? String else { return }
    switch kind {
    case "interactive":
      panel.ignoresMouseEvents = !(msg["on"] as? Bool ?? false)
    case "keyboard":
      keyboard(msg["on"] as? Bool ?? false)
    case "copy":
      copy(id: msg["id"], rect: msg["rect"] as? [String: Any] ?? [:])
    case "approval":
      // a vault approval, clicked in her panel: straight to the service over fd 3 (a pipe only
      // it holds; never over HTTP, where an agent could fake it)
      guard msg["trusted"] as? Bool == true, let id = msg["id"] as? String,
            let decision = msg["decision"] as? String, decision == "allow" || decision == "deny" else { return }
      approvals.send(["type": "approval", "id": id, "decision": decision])
    case "console":
      log("[page \(msg["level"] as? String ?? "log")]", msg["text"] as? String ?? "")
    default:
      break
    }
  }

  func keyboard(_ on: Bool) {
    panel.wantsKeyboard = on
    if on {
      panel.makeKeyAndOrderFront(nil)
      panel.makeFirstResponder(view)
    } else if panel.isKeyWindow {
      // a panel only stops being the key window by leaving the screen: out and straight back in
      panel.orderOut(nil)
      panel.orderFrontRegardless()
    }
  }

  func reply(toPage id: Any?, _ value: Bool) {
    guard let id = id as? Int else { return }
    view.evaluateJavaScript("window.__capriShellReply && window.__capriShellReply(\(id), \(value))", completionHandler: nil)
  }

  func copy(id: Any?, rect: [String: Any]) {
    let num = { (key: String, fallback: CGFloat) in (rect[key] as? NSNumber).map { CGFloat(truncating: $0) } ?? fallback }
    let snapshot = WKSnapshotConfiguration()
    snapshot.rect = CGRect(x: num("x", 0), y: num("y", 0), width: num("width", view.bounds.width), height: num("height", view.bounds.height))
      .intersection(view.bounds)
    view.takeSnapshot(with: snapshot) { [weak self] image, error in
      guard let image else {
        log("copy failed:", error?.localizedDescription ?? "no image")
        self?.reply(toPage: id, false)
        return
      }
      NSPasteboard.general.clearContents()
      self?.reply(toPage: id, NSPasteboard.general.writeObjects([image]))
    }
  }

  // ---------- the pointer ----------
  // The overlay lets everything through except while the pointer is on her, so the page gets no
  // pointer events of its own elsewhere. The system tells us each time the pointer moves (no
  // polling) and we hand that to the page, at most 30 times a second.

  var pointer: (x: Double, y: Double, inside: Bool) {
    let p = NSEvent.mouseLocation
    let f = screen.frame
    return (Double(p.x - f.minX), Double(f.maxY - p.y), f.contains(p))
  }

  func startPointer() {
    let moves: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
    NSEvent.addGlobalMonitorForEvents(matching: moves) { [weak self] e in self?.pointerMoved(dragging: e.type != .mouseMoved) }
    NSEvent.addLocalMonitorForEvents(matching: moves) { [weak self] e in
      self?.pointerMoved(dragging: false)
      return e
    }
    // a window let go of, or a click that raised another one
    NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp]) { [weak self] _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self?.pollWindows() }
    }
  }

  func pointerMoved(dragging: Bool) {
    let now = ProcessInfo.processInfo.systemUptime
    // a drag might be a window on the move: keep up with it
    if dragging, now - windowsAt > 0.066 { pollWindows() }
    if cursorQueued { return }
    let wait = max(0, 0.033 - (now - cursorAt))
    if wait == 0 { return sendPointer() }
    cursorQueued = true
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.sendPointer() }
  }

  func sendPointer() {
    cursorQueued = false
    cursorAt = ProcessInfo.processInfo.systemUptime
    let p = pointer
    view.evaluateJavaScript("window.__capriCursor && window.__capriCursor({x:\(p.x),y:\(p.y),inside:\(p.inside)})", completionHandler: nil)
  }

  // ---------- the windows ----------
  // Where the other apps' windows are on her screen, front first. macOS has no feed of window
  // moves without the Accessibility permission, so: look when something says they may have
  // changed (an app comes forward, starts, quits, hides; the space changes; the mouse drags or
  // lets go), and once a second for the rest (keyboard shortcuts). The list is only sent when it
  // differs from the last one.

  func startWindows() {
    let center = NSWorkspace.shared.notificationCenter
    for name in [
      NSWorkspace.didActivateApplicationNotification, NSWorkspace.didLaunchApplicationNotification,
      NSWorkspace.didTerminateApplicationNotification, NSWorkspace.didHideApplicationNotification,
      NSWorkspace.didUnhideApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification,
    ] {
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.pollWindows()
        // windows are still sliding in when the notification comes
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self?.pollWindows() }
      }
    }
    let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.pollWindows() }
    timer.tolerance = 0.3
    RunLoop.main.add(timer, forMode: .common)
    windowsTimer = timer
    pollWindows()
  }

  static let games = try! NSRegularExpression(pattern: "steam|wine|proton|minecraft|heroic|retroarch|dolphin|ppsspp|rpcs3|crossover|whisky", options: .caseInsensitive)

  func pollWindows() {
    windowsAt = ProcessInfo.processInfo.systemUptime
    let b = bounds
    let menuBar = screen.frame.maxY - screen.visibleFrame.maxY
    let usable = screen.visibleFrame.height // without the menu bar and the Dock
    let me = ProcessInfo.processInfo.processIdentifier
    let front = NSWorkspace.shared.frontmostApplication
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var wins: [[String: Any]] = []
    var fg = 0
    var fullscreen = false
    for w in list {
      guard w[kCGWindowLayer as String] as? Int == 0,
            let pid = w[kCGWindowOwnerPID as String] as? Int32, pid != me,
            let id = w[kCGWindowNumber as String] as? Int,
            (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.01,
            let box = w[kCGWindowBounds as String] as? NSDictionary,
            let r = CGRect(dictionaryRepresentation: box),
            r.width >= 120, r.height >= 80, b.contains(CGPoint(x: r.midX, y: r.midY)) else { continue }
      let covers = r.width >= b.width - 4
      let full = covers && r.height >= b.height - 4
      if fg == 0, pid == front?.processIdentifier {
        fg = id
        fullscreen = full
      }
      wins.append([
        "id": id, "pid": Int(pid),
        "x": Int(r.minX - b.minX), "y": Int(r.minY - b.minY), "w": Int(r.width), "h": Int(r.height),
        "max": full || (covers && r.height >= usable - 4),
      ])
    }
    var game = false
    if fullscreen, let front {
      let category = front.bundleURL.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "LSApplicationCategoryType") as? String } ?? ""
      let name = "\(front.localizedName ?? "") \(front.bundleIdentifier ?? "")"
      game = category.contains("games") || Shell.games.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
    }
    let snap: [String: Any] = [
      "type": "windows", "fg": fg, "wins": wins, "fullscreen": fullscreen,
      "game": game ? (front?.localizedName ?? "") : NSNull(),
      "screen": ["name": screen.localizedName, "width": Int(b.width), "height": Int(b.height), "menuBar": Int(menuBar)],
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: snap, options: .sortedKeys), let key = String(data: data, encoding: .utf8) else { return }
    if key == lastWindows { return }
    lastWindows = key
    service.send(snap)
  }

  // ---------- her menu bar icon and her menu ----------

  func startStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let icon, let image = NSImage(contentsOfFile: icon) {
      image.size = NSSize(width: 18, height: 18)
      item.button?.image = image
    } else {
      item.button?.title = "C"
    }
    item.button?.toolTip = "Capri"
    item.button?.target = self
    item.button?.action = #selector(statusClicked)
    statusItem = item
  }

  // the service owns the menu (what's in it depends on her settings): ask it to open one
  @objc func statusClicked() { service.send(["type": "menu"]) }

  var menuPick = -1
  @objc func menuPicked(_ sender: NSMenuItem) { menuPick = sender.tag }

  // items: [{ label, on? }]; answers the index picked, or -1
  func menu(_ items: [[String: Any]]) -> Int {
    let menu = NSMenu()
    menu.autoenablesItems = false
    for (i, entry) in items.enumerated() {
      if entry["separator"] as? Bool == true { menu.addItem(.separator()); continue }
      let item = NSMenuItem(title: entry["label"] as? String ?? "", action: #selector(menuPicked), keyEquivalent: "")
      item.target = self
      item.tag = i
      if let on = entry["on"] as? Bool { item.state = on ? .on : .off }
      menu.addItem(item)
    }
    menuPick = -1
    // under her icon if that's where the pointer is, at the pointer otherwise (right-click on her)
    if let button = statusItem?.button, let w = button.window, w.frame.contains(NSEvent.mouseLocation) {
      menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.maxY + 4), in: button)
    } else {
      NSApp.activate(ignoringOtherApps: true) // or the menu wouldn't close on a click elsewhere
      menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }
    return menuPick
  }

  // where her icon is, in her coordinates
  func tray() -> Any {
    guard let frame = statusItem?.button?.window?.frame, frame.width > 0, screen.frame.intersects(frame) else { return NSNull() }
    let f = screen.frame
    return ["x": Int(frame.minX - f.minX), "y": Int(f.maxY - frame.maxY), "w": Int(frame.width), "h": Int(frame.height)]
  }

  // ---------- the service's requests ----------

  static let keep: Set<String> = ["com.t3tools.t3code", "com.apple.finder", "com.apple.loginwindow"]

  func apps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
      $0.activationPolicy == .regular && $0.bundleIdentifier != nil && !Shell.keep.contains($0.bundleIdentifier!)
        && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
    }
  }

  func startRequests() {
    let input = FileHandle.standardInput
    var pending = Data()
    input.readabilityHandler = { handle in
      let chunk = handle.availableData
      if chunk.isEmpty { // the service is gone
        DispatchQueue.main.async { NSApp.terminate(nil) }
        return
      }
      pending.append(chunk)
      while let nl = pending.firstIndex(of: 0x0A) {
        let line = pending.subdata(in: pending.startIndex..<nl)
        pending.removeSubrange(pending.startIndex...nl)
        guard let msg = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
        DispatchQueue.main.async { self.handle(msg) }
      }
    }
  }

  func handle(_ msg: [String: Any]) {
    let id = msg["id"] as? Int ?? 0
    let answer = { (value: Any) in service.send(["type": "reply", "id": id, "value": value]) }
    switch msg["type"] as? String {
    case "cursor":
      let p = pointer
      answer(["x": p.x, "y": p.y, "inside": p.inside])
    case "tray":
      answer(tray())
    case "menu":
      answer(menu(msg["items"] as? [[String: Any]] ?? []))
    case "apps":
      answer(apps().map { ["name": $0.localizedName ?? "", "process": $0.bundleIdentifier ?? "", "pid": Int($0.processIdentifier)] })
    case "closeApp":
      // like Cmd+Q, so the app can still ask to save; forcing kills it
      let force = msg["force"] as? Bool ?? false
      let name = msg["name"] as? String ?? ""
      let found = apps().filter { $0.bundleIdentifier == name }
      for app in found { _ = force ? app.forceTerminate() : app.terminate() }
      DispatchQueue.main.asyncAfter(deadline: .now() + (found.isEmpty ? 0 : force ? 0.6 : 2.5)) {
        answer(["running": self.apps().contains { $0.bundleIdentifier == name }])
      }
    case "media":
      Player.control(msg["action"] as? String ?? "") { answer($0) }
    case "playUri":
      Player.play(msg["uri"] as? String ?? "") { answer($0) }
    case "mediaStatus":
      Player.status { answer($0) }
    case "snapshot":
      // what the page looks like right now, as a PNG file (debugging: `capri --dev`)
      view.takeSnapshot(with: nil) { image, _ in
        guard let path = msg["path"] as? String, let tiff = image?.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return answer(false) }
        answer((try? png.write(to: URL(fileURLWithPath: path))) != nil)
      }
    case "quit":
      NSApp.terminate(nil)
    default:
      answer(NSNull())
    }
  }
}

// ---------- go ----------

// macOS asks "may Capri control Spotify?" of whichever app is held responsible for this process,
// and by default that's the one at the top of the family (the terminal the service was started
// from), which gets a silent no. So: start over once, as our own responsible process. Same pid
// and same pipes; this is what lldb and VS Code's terminal do for the programs they start.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attr: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

if getenv("CAPRI_OWN_PROCESS") == nil {
  setenv("CAPRI_OWN_PROCESS", "1", 1)
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
  if responsibility_spawnattrs_setdisclaim(&attr, 1) == 0 {
    var argv = CommandLine.arguments.map { strdup($0) } + [nil]
    posix_spawn(nil, Bundle.main.executablePath ?? CommandLine.arguments[0], nil, &attr, &argv, environ)
  }
  // still here: it didn't work, carry on as we are (only the music controls would miss out)
}

signal(SIGPIPE, SIG_IGN)
var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
guard let target = option("--url").flatMap(URL.init(string:)) else {
  FileHandle.standardError.write("usage: capri-shell --url <url> [--output <screen name>] [--icon <png>]\n".data(using: .utf8)!)
  exit(2)
}
let app = NSApplication.shared
let shell = Shell(url: target, output: option("--output"), icon: option("--icon"))
app.delegate = shell
app.setActivationPolicy(.accessory) // no Dock icon, never in the app switcher
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
term.setEventHandler { NSApp.terminate(nil) }
term.resume()
app.run()
