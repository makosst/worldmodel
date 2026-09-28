"""Run a command in its own session so it survives the parent (e.g. a crashed Claude Code) dying.

    python3 scripts/detach.py logs/name.log cmd args...
"""
import os, subprocess, sys

log = open(sys.argv[1], "ab")
p = subprocess.Popen(sys.argv[2:], stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True, cwd=os.getcwd())
print(p.pid)
