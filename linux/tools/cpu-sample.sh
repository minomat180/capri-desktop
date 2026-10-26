#!/bin/sh
# cpu-sample.sh SECONDS: CPU% per process of interest, and package power (RAPL), over SECONDS.
secs=${1:-20}
hz=$(getconf CLK_TCK)
pids=$(pgrep -d ' ' -f 'mango$|^mango |spike_shell.py|capri-shell|WebKitWebProcess|WebKitNetworkProcess|WebKitGPUProcess|capri-daemon')
rapl=/sys/class/powercap/intel-rapl:0/energy_uj
ticks() { for p in $pids; do [ -r /proc/$p/stat ] && awk -v p=$p '{print p, $14+$15}' /proc/$p/stat; done; }
e0=$(sudo cat $rapl 2>/dev/null)
ticks > /tmp/cpu0.$$
sleep "$secs"
ticks > /tmp/cpu1.$$
e1=$(sudo cat $rapl 2>/dev/null)
join /tmp/cpu0.$$ /tmp/cpu1.$$ | while read -r p a b; do
  name=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-60)
  awk -v d=$((b - a)) -v hz=$hz -v s=$secs -v n="$name" 'BEGIN { printf "%6.1f%%  %s\n", 100 * d / hz / s, n }'
done
rm -f /tmp/cpu0.$$ /tmp/cpu1.$$
[ -n "$e0" ] && [ -n "$e1" ] && awk -v a=$e0 -v b=$e1 -v s=$secs 'BEGIN { printf "package power: %.2f W\n", (b - a) / 1e6 / s }'
echo "on AC: $(cat /sys/class/power_supply/AC/online)"
