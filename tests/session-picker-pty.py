#!/usr/bin/env python3
"""Real Pi + real personal/npm extensions; no remote/model calls.
Run: nix-shell -p python3Packages.pyte --run 'python tests/session-picker-pty.py'
--repro reports the pre-fix behavior without failing its expected assertions.
"""
import argparse
import datetime
import errno
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import time
import termios
import pyte

parser = argparse.ArgumentParser()
parser.add_argument('--repro', action='store_true')
parser.add_argument('--mode', choices=['regular', 'fullscreen'], default='fullscreen')
parser.add_argument('--extra-sessions', type=int, default=130, help='Additional parent sessions; default creates 134 JSONL files')
args = parser.parse_args()
work = pathlib.Path(tempfile.mkdtemp(prefix='pi-picker-pty-', dir='/tmp'))
sessions = work / 'sessions'
sessions.mkdir()
root = sessions / 'parent.jsonl'
children = [sessions / ('child-' + str(i) + '.jsonl') for i in range(3)]
names = ['PTY Parent', 'PTY Child Alpha', 'PTY Child Beta', 'PTY Child Gamma']
others = [sessions / ('other-' + str(i) + '.jsonl') for i in range(args.extra_sessions)]
for i, file in enumerate([root] + children + others):
    date = datetime.datetime.now(datetime.timezone.utc)
    if i >= len(names):
        date -= datetime.timedelta(minutes=60 + i)
    timestamp = date.isoformat()
    name = names[i] if i < len(names) else 'PTY Other Parent ' + str(i)
    entries = [
        {'type': 'session', 'version': 3, 'id': 'pty-' + str(i), 'timestamp': timestamp, 'cwd': str(work), **({'parentSession': str(root)} if 0 < i < len(names) else {})},
        {'type': 'session_info', 'id': 'info-' + str(i), 'parentId': None, 'timestamp': timestamp, 'name': name},
        {'type': 'message', 'id': 'message-' + str(i), 'parentId': 'info-' + str(i), 'timestamp': timestamp,
         'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'PTY test fixture'}], 'timestamp': int(date.timestamp() * 1000)}},

    ]
    file.write_text('\n'.join(json.dumps(entry) for entry in entries) + '\n')
provider = work / 'offline-provider.ts'
provider.write_text('''import { appendFileSync } from "node:fs";
export default function(pi) {
  pi.registerProvider("picker-offline", { api: "openai-responses", baseUrl: "http://127.0.0.1:1", apiKey: "offline-test", models: [{id: "chooser", name: "Offline picker test", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}] });
  pi.on("before_provider_request", () => { appendFileSync(''' + json.dumps(str(work / 'unexpected-model-request')) + ''', "unexpected request\\n"); throw new Error("This test must not call a model"); });
  pi.on("session_start", (_event, ctx) => {
    let terminal;
    ctx.ui.setWidget("pty-test:focus", (tui) => { terminal = tui; return {render: () => [], invalidate() {}}; });
    ctx.ui.setWidget("pty-test:focus", undefined);
    ctx.ui.onTerminalInput((data) => { appendFileSync(''' + json.dumps(str(work / 'input.log')) + ''', JSON.stringify({data, focus: terminal?.getFocusedComponent()?.constructor?.name, time: Date.now()}) + "\\n"); });
  });
}
''')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
env = dict(os.environ)
for key in ['PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL']:
    env.pop(key, None)
env.update(TERM='xterm-256color', COLORTERM='truecolor', PI_OFFLINE='1', PI_TELEMETRY='0')
command = ['pi', '--offline', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-tools', '--approve', '--session', str(root), '--session-dir', str(sessions), '--tui-mode', args.mode, '--extension', str(provider), '--provider', 'picker-offline', '--model', 'chooser']
process = subprocess.Popen(command, cwd=work, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
screen = pyte.Screen(140, 40)
stream = pyte.Stream(screen)
raw = bytearray()

def snapshot():
    return '\n'.join(screen.display)

def receive(timeout):
    ready, _, _ = select.select([master], [], [], timeout)
    if not ready:
        return False
    try:
        chunk = os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            raise RuntimeError('Pi exited: ' + snapshot())
        raise
    if not chunk:
        raise RuntimeError('Pi exited: ' + snapshot())
    raw.extend(chunk)
    stream.feed(chunk.decode('utf-8', errors='replace'))
    for query, reply in [(b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[>c', b'\x1b[>0;0;0c'), (b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[?u', b'\x1b[?0u')]:
        if query in chunk:
            os.write(master, reply)
    return True

def wait_for(predicate, timeout=15):
    deadline = time.monotonic() + timeout
    while True:
        if predicate(snapshot()):
            return snapshot()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Timed out; terminal snapshot:\n' + snapshot())
        receive(remaining)

def settled():
    # Drain renderer updates until the output becomes quiet, bounded by one second.
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline and receive(0.15):
        pass
    return snapshot()

def send(data):
    os.write(master, data.encode() if isinstance(data, str) else data)

def visible_total(text):
    match = re.search(r'\(\d+/(\d+)\) .*resume', text)
    return int(match.group(1)) if match else None

def open_picker(command_name):
    send(command_name + '\r')
    wait_for(lambda text: 'Resume Session' in text and 'PTY Parent' in text)
    if not args.repro and command_name != '/resume-native':
        wait_for(lambda text: 'Loading' not in text and 'Load failed' not in text and visible_total(text) == 1 + args.extra_sessions)
    return settled()

def close_picker():
    send(b'\x1b')
    wait_for(lambda text: 'Resume Session' not in text)
    settled()

results = {}
try:
    wait_for(lambda text: 'Offline picker test' in text and 'PTY test fixture' in text)
    settled()
    for name in ['/resume', '/session-picker', '/resume-native']:
        text = open_picker(name)
        label = name[1:]
        (work / (label + '-initial.txt')).write_text(text)
        results[label + '_collapsed'] = not any(child in text for child in names[1:])
        if name != '/resume-native':
            if not args.repro:
                assert visible_total(text) == 1 + args.extra_sessions, 'Missing sessions after final loading'
            # The original bug crashed here after a count-only progress callback.
            for key in [b'\x1b[B', b'\x1b[A', b'\x1b[6~', b'\x1b[5~']:
                send(key)
                settled()
            results[label + '_navigation_survives'] = process.poll() is None
            send(b'\x1b[C')
            if not args.repro:
                wait_for(lambda text: all(child in text for child in names[1:]))
            text = settled()
            (work / (label + '-expanded.txt')).write_text(text)
            results[label + '_right_expands'] = all(child in text for child in names[1:])
            if not args.repro:
                assert visible_total(text) == len(names) + args.extra_sessions, 'Expansion lost loaded sessions'
            send(b'\x1b[D')
            if not args.repro:
                wait_for(lambda text: not any(child in text for child in names[1:]))
            text = settled()
            (work / (label + '-collapsed.txt')).write_text(text)
            results[label + '_left_collapses'] = not any(child in text for child in names[1:])
            if not args.repro:
                assert visible_total(text) == 1 + args.extra_sessions
                send('\t')
                wait_for(lambda text: 'Resume Session (All)' in text and 'Loading' not in text and visible_total(text) == 1 + args.extra_sessions)
                send(b'\x1b[B'); send(b'\x1b[A'); settled()
                send('\t')
                wait_for(lambda text: 'Resume Session (Current Folder)' in text and 'Loading' not in text and visible_total(text) == 1 + args.extra_sessions)
                send('"PTY Child Alpha"')
                wait_for(lambda text: visible_total(text) == 1 and 'PTY Child Alpha' in text)
                send(b'\x15')
                wait_for(lambda text: visible_total(text) == 1 + args.extra_sessions and not any(child in text for child in names[1:]))
                results[label + '_scope_search_survives'] = process.poll() is None
        close_picker()
    if not args.repro:
        send('/reload\r')
        wait_for(lambda text: 'Reloaded keybindings' in text, timeout=25)
        settled()
        text = open_picker('/resume')
        results['resume_after_reload_collapsed'] = not any(child in text for child in names[1:])
        send(b'\x1b[C')
        wait_for(lambda text: all(child in text for child in names[1:]))
        send(b'\x1b[D')
        wait_for(lambda text: not any(child in text for child in names[1:]))
        text = settled()
        (work / 'resume-after-reload.txt').write_text(text)
        results['resume_after_reload_arrows'] = not any(child in text for child in names[1:])
        close_picker()
    assert not (work / 'unexpected-model-request').exists(), 'Unexpected model request'
    print(json.dumps({'mode': args.mode, 'session_files': len(names) + args.extra_sessions, 'results': results, 'artifacts': str(work)}, indent=2))
    if not args.repro:
        for name in ['resume', 'session-picker']:
            for suffix in ['collapsed', 'right_expands', 'left_collapses', 'navigation_survives', 'scope_search_survives']:
                assert results[name + '_' + suffix], name + '_' + suffix + ' failed'
        assert not results['resume-native_collapsed'], 'Native picker should remain unchanged'
        assert results['resume_after_reload_collapsed'] and results['resume_after_reload_arrows'], 'Reload lost the resume routing'
finally:
    (work / 'terminal.raw').write_bytes(raw)
    print('Terminal artifacts:', work)
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    os.close(master)
