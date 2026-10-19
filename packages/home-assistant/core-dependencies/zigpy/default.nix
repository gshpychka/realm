{ zigpy }:
# A released semaphore slot may start a queued task before the second
# equal-duration task finishes. Test semaphore capacity and task causality.
zigpy.overridePythonAttrs (old: {
  patches = (old.patches or [ ]) ++ [ ./zigpy-test-order.patch ];
})
