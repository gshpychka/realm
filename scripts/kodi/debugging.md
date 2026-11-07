# Debugging Kodi on the box

Facts for investigating the kodi box: playback, A/V sync, memory and crashes.
Deployment and the patch list live in `runbook.md`.

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
- Kodi answers JSON-RPC on TCP port 9090, e.g. on the box
  `printf %s '{"jsonrpc":"2.0","id":1,"method":"Player.GetActivePlayers"}' | nc -w 3 127.0.0.1 9090`,
  as `cpm/flash.sh` does. Kodi's notifications arrive on the same connection,
  so a client picks its reply out by `id`.
  `Player.GetProperties` reports time 0 with nothing playing;
  `Player.GetActivePlayers` returns `[]` then. `Player.Seek` takes
  `{"time":{"hours":1,"minutes":3,"seconds":41}}` for a time and
  `{"seconds":-30}` for a relative seek; JSON numbers carry no leading zeros.

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
  Calls need explicit casts, e.g. `call (int)malloc_trim(0)`, and stop Kodi
  for a fraction of a second.
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
  `CDVDClock::ErrorAdjust` lines move the clock and with it the picture. The
  last `below threshold` line marks when sync settled.
- PlexKodiConnect logs `Session key … still unknown! Skip playstate update`
  every 10 s during playback, and defers its scheduled full sync while video
  plays.
- The playback info panel's A/V sync row is ActiveAE's audio-to-clock error.
  Kodi's player debug overlay (action `playerdebug`) measures differently: its
  `a/c` is the audio player's own position estimate, about 0.2 s behind with
  passthrough at times, and its `v/c` is when the renderer hands a frame to
  the display, up to a frame ahead of the clock.
- Opening a file while another plays runs the old playback's Dolby Vision
  teardown and the new one's setup at once. Once this ended Kodi's main
  thread: the GUI froze and every JSON-RPC call hung. Stop playback and wait
  for `Player.GetActivePlayers` to return `[]` before opening the next file.
- Kodi's screenshots come out black on this box. The GUI layer is readable
  from `/dev/fb0`: `virtual_size` in `/sys/class/graphics/fb0` gives the
  double-buffered geometry, and each half is a BGRA frame of `stride` bytes per
  line.

## Memory

- Playback holds about 1.1 GB of buffers: the 512 MB file cache
  (`filecache.memorysize`), CPM's video packet queue, which fills to 256 MB of
  data (about 75 s of a remux), and a 36 MB audio queue. Stopping playback frees
  them; glibc keeps the freed heap for the next playback, so RSS stays high.
- RSS therefore says little about leaks; malloc's own report does. In
  `gdb -p $(pidof kodi.bin)`: `set $f = (void*)fopen("/tmp/mi.xml", "w")`,
  `call (int)malloc_info(0, $f)`, `call (int)fclose($f)`, `detach`. Per arena
  (`<heap nr=…>`), memory in use is `<system type="current">` minus the sizes
  of `<total type="fast">` and `<total type="rest">`, and it counts the
  arena's free top chunk too; `<total type="mmap">` covers blocks with a
  mapping of their own. Compare samples with playback running and after it
  stops.
- A memory soak keeps a video playing and lists a Bingie widget every 10 s
  (`Files.GetDirectory` on a `plugin://script.bingie.widgets/` path) from
  transient units, sampling malloc's report every few minutes.
- Kodi runs with `MALLOC_ARENA_MAX=2` (`system.d/kodi.service.d/memory.conf`).
  Kodi runs every add-on script on a new thread, and without the cap each
  thread's arena keeps what its script freed.
- An add-on's Python objects are visible from inside it: a temporary thread in
  its service that logs `collections.Counter(type(o).__name__ for o in
  gc.get_objects())` each minute shows what grows. Restart Kodi to load it, and
  remove it after.

## Building and patching

- `cpm/build.sh` takes 2 to 3 minutes for a Kodi-only change. It applies
  `cpm/patches/kodi/*.patch` in file name order, so a patch is made against
  the tree with the earlier patches applied; `patch` accepts line offsets.
- The tree it built is in its work directory, under
  `build.CoreELEC-Amlogic-ng.aarch64-22/build/kodi-<commit>/`. Grep there to
  confirm a patch landed.
- `cpm/flash.sh` writes a 1.4 GB backup per flash, and the images in the
  work directory's `target/` belong to root (the build runs in Docker).
- CPM's Kodi source: <https://github.com/cpm-code/xbmc> at the commit
  `cpm-code/CoreELEC` pins.
