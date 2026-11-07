set pagination off
set confirm off
handle SIGPIPE SIGUSR1 SIGUSR2 SIG33 SIG34 SIG35 nostop noprint pass
set $f = (void*)fopen("/tmp/kodi-malloc-info.xml", "w")
call (int)malloc_info(0, $f)
call (int)fclose($f)
detach
quit
