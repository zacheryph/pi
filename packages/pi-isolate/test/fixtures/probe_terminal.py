"""Drive the launcher in a real controlling terminal; never used by the launcher."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

request = json.load(sys.stdin)
pid, master = pty.fork()
if pid == 0:
    os.chdir(request["cwd"])
    os.execve(request["argv"][0], request["argv"], request["env"])

initial = termios.tcgetattr(master)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
output = b""
ready_at = None
sent = False
finished = False
status = None
try:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                output += os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        if ready_at is None and b"scripted-model" in output:
            ready_at = time.monotonic() + 1
        if not sent and ready_at is not None and time.monotonic() >= ready_at:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 110, 0, 0))
            os.write(master, b"probe\r")
            sent = True
        if not finished and b"isolation-probe-ok" in output:
            os.write(master, b"\x04")
            finished = True
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited:
            break
    else:
        raise RuntimeError("TUI probe timed out: " + output[-4000:].decode(errors="replace"))
    restored = termios.tcgetattr(master)
    mask = termios.ICANON | termios.ECHO | termios.ISIG
    assert initial[3] & mask == restored[3] & mask, "terminal flags were not restored"
    assert sent and finished, "TUI did not answer: " + output[-6000:].decode(errors="replace")
    assert os.waitstatus_to_exitcode(status) == 0, "TUI exited unsuccessfully"
    print(json.dumps({"prompt": True, "resize": True, "eof": True, "terminalRestored": True}))
finally:
    try:
        os.killpg(pid, signal.SIGTERM)
        time.sleep(0.2)
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(master)
