# Security

This is a personal fork maintained by one person, with no releases and no support promise.

If you find a security problem, report it privately through GitHub's
[security advisories](https://github.com/minomat180/capri-desktop/security/advisories/new)
rather than a public issue. The parts worth a close look:

- the service listens on `127.0.0.1:47823`; its control routes need the per-run token in
  `$XDG_RUNTIME_DIR/capri/token` (macOS: `$TMPDIR/capri/token`)
- the approval API, which must only accept an answer from a real click passed over the overlay's
  private pipe (see `linux/docs/vault-approvals.md`)
- `hooks/capri-hook.js`, which runs inside every Claude Code session

Problems in the original Windows app belong upstream:
[mochiiwuff/capri-desktop](https://github.com/mochiiwuff/capri-desktop).
