# Debugging Kodi on the box

Facts and tools for investigating the kodi box: playback, A/V sync, memory and
crashes. Deployment and the patch list live in `../runbook.md`.

## The box

- `ssh kodi` logs in as root. From reaper it uses reaper's TPM key, so it needs
  no forwarded agent.
- CEC suspends the box when the TV goes to standby, which ends SSH sessions and
  test runs. For a long unattended test, run
  `systemctl mask --runtime suspend.target sleep.target`; the mask lasts until
  the next boot, or `systemctl unmask --runtime …` lifts it.
- `/tmp` is empty after every boot and every flash. `/storage` persists.
- Commands are BusyBox: `grep` has no `--include`, `ls` has no
  `--time-style`, and there is no `timeout` or `setsid`. A job outlives the
  SSH session as a transient unit: `systemd-run --unit=NAME …`. Python 3 is
  available.
- Kodi listens for JSON-RPC on TCP port 9090; `rpc.py` below is a client.
  `Player.GetProperties` reports time 0 with nothing playing;
  `Player.GetActivePlayers` returns `[]` then.

## Logs and crashes

- Debug logging is on (`<loglevel>1</loglevel>` in `advancedsettings.xml`),
  about 130 MB an hour in `/storage/.kodi/temp/kodi.log`; the previous run's log
  is `kodi.old.log`.
- Log lines from code that logs through a component (`LOGAUDIO`, `LOGVIDEO`)
  appear only with that component enabled in Kodi's debug settings. CPM's
  passthrough jitter correction for DTS-HD MA writes no log line of its own;
  its `CDVDClock::ErrorAdjust - passthrough-jitter` line shows it.
- A crash leaves `/storage/.kodi/temp/kodi_crashlog_<time>.log` with every
  thread's stack and the log's tail. CoreELEC deletes the core file after
  writing it. Kodi starts its early threads in the same order every run, so a
  low LWP's position among the crashed process's LWPs matches a thread name in
  the running Kodi's `/proc/$(pidof kodi.bin)/task/*/comm`.
- gdb is installed and attaches to the running Kodi without debug symbols.
  Calls need explicit casts, e.g. `call (int)malloc_trim(0)`. `heapstats.gdb`
  shows the pattern.
- `dd if=/proc/$(pidof kodi.bin)/mem bs=4096 skip=… count=…` reads Kodi's
  memory. While the heap grows, the top of `[heap]` in `/proc/<pid>/maps`
  holds the newest allocations, and `strings` on a dump of it often shows
  whose data they are.

## Playback facts

- Every playback start switches the display from the GUI's 30 Hz to the
  video's rate. Kodi pauses playback and ActiveAE closes the HDMI output for
  about 5 s (`OnLostDisplay` … `display reset event`), and ActiveAE refuses new
  audio streams meanwhile.
- Bingie plays a startup intro video after each Kodi start. A video opened
  during it starts inside that display switch; open test videos after
  `Player.GetActivePlayers` returns `[]`.
- A seek to a time starts the video at the keyframe before the target and the
  audio at the target, so the audio waits up to a second for the clock. A
  relative seek of a few seconds starts both together.
- The A/V sync story in the log: `start sync of audio stream`, then
  `SyncStream - average error of …, start adjusting` until `below threshold`;
  `CDVDClock::ErrorAdjust` lines move the clock and with it the picture.
  `syncprobe.sh` collects them.
- PlexKodiConnect logs `Session key … still unknown! Skip playstate update`
  every 10 s during playback, and defers its scheduled full sync while video
  plays.

## Memory

- Playback holds about 1.1 GB of buffers: the 512 MB file cache
  (`filecache.memorysize`), CPM's video packet queue, which fills to 256 MB of
  data (about 75 s of a remux), and a 36 MB audio queue. Stopping playback frees
  them; glibc keeps the freed heap for the next playback, so RSS stays high.
- RSS therefore says little about leaks. `heapstats.sh` reads what malloc holds
  in use; compare samples with playback running and after it stops.
- Kodi runs with `MALLOC_ARENA_MAX=2` (`../kodi-memory.conf`). Kodi runs every
  add-on script on a new thread, and without the cap each thread's arena keeps
  what its script freed.
- An add-on's Python objects are visible from inside it: a temporary thread in
  its service that logs `collections.Counter(type(o).__name__ for o in
  gc.get_objects())` each minute shows what grows. Restart Kodi to load it, and
  remove it after.

## Building and patching

- `../cpm/build.sh` takes 2 to 3 minutes for a Kodi-only change. It applies
  `../cpm/patches/kodi/*.patch` in file name order, so a patch is made against
  the tree with the earlier patches applied; `patch` accepts line offsets.
- The tree it built is in its work directory, under
  `build.CoreELEC-Amlogic-ng.aarch64-22/build/kodi-<commit>/`. Grep there to
  confirm a patch landed.
- `../cpm/flash.sh` writes a 1.4 GB backup per flash, and the images in the
  work directory's `target/` belong to root (the build runs in Docker).
- CPM's Kodi source: <https://github.com/cpm-code/xbmc> at the commit
  `cpm-code/CoreELEC` pins.

## Tools

Copy them to the box, then run them there:

```sh
ssh kodi mkdir -p /storage/kodi-debug
scp scripts/kodi/debug/* kodi:/storage/kodi-debug/
```

- `rpc.py METHOD [PARAMS_JSON]` calls one JSON-RPC method and prints the result,
  e.g. `python3 rpc.py Player.GetProperties '{"playerid":1,"properties":["time"]}'`.
  Other tools import its `call`.
- `syncprobe.sh seek|pause|open …` performs one playback action and prints the
  audio sync events of the next 10 s, with a summary: when sync settled, how
  many adjust cycles and clock corrections it took.
- `heapstats.sh [INTERVAL]` prints malloc's in-use and claimed memory per arena,
  its separately mapped blocks and RSS.
- `soak-playback.sh` keeps an episode playing, and `soak-widgets.sh` runs a
  widget's add-on script every 10 s; run each as a transient unit, e.g.
  `systemd-run --unit=soak-playback sh /storage/kodi-debug/soak-playback.sh`,
  with `heapstats.sh 300` logging alongside.

`rm -r /storage/kodi-debug` removes them.
