#!/usr/bin/env python3
"""Exercise one live window using wincap's stdin/stdout protocol."""
import argparse
from contextlib import contextmanager
import os
import select
import struct
import subprocess
import time


@contextmanager
def stream(command, stdout=subprocess.PIPE):
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=stdout, bufsize=0)
    try:
        yield child
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdin.close()
        if child.stdout:
            child.stdout.close()


def read_exact(fd, count, deadline):
    data = bytearray()
    while len(data) < count:
        if not select.select([fd], [], [], max(0, deadline - time.monotonic()))[0]:
            raise TimeoutError("PULL did not produce a complete record")
        chunk = os.read(fd, count - len(data))
        if not chunk:
            raise EOFError("helper exited before answering PULL")
        data.extend(chunk)
    return data


class Records:
    def __init__(self, child, codec, fd=None):
        self.child = child
        self.codec = codec
        self.fd = child.stdout.fileno() if fd is None else fd
        self.pts = 0

    def nal_type(self, nal):
        return nal[0] & 31 if self.codec == "h264" else (nal[0] >> 1) & 63

    def pull(self, tier, reset=0):
        self.child.stdin.write(f"PULL {tier} {reset}\n".encode("ascii"))
        deadline = time.monotonic() + 7
        length, = struct.unpack(">I", read_exact(self.fd, 4, deadline))
        assert 1 <= length <= 24577, length
        record = read_exact(self.fd, length, deadline)
        tag = record[0]
        if tag in (0, 2):
            assert length == 1
            return tag, None, None
        body = record[1:]
        assert tag == 1 and len(body) > 24
        magic, sync, count, width, height, reserved, seq, pts = struct.unpack_from(">4sBBHHHIQ", body)
        assert magic == b"MWV1" and sync in (0, 1) and reserved == seq == 0
        assert all(2 <= side <= (320, 480, 640, 960)[tier] and side % 2 == 0 for side in (width, height))
        assert pts > self.pts
        self.pts = pts

        offset = 24

        def take_nal(prefix):
            nonlocal offset
            assert len(body) >= offset + prefix
            size = int.from_bytes(body[offset:offset + prefix], "big")
            offset += prefix
            assert 0 < size <= len(body) - offset
            nal = body[offset:offset + size]
            offset += size
            return self.nal_type(nal)

        expected = [7, 8] if self.codec == "h264" else [32, 33, 34]
        assert [take_nal(2) for _ in range(count)] == (expected if sync else [])
        units = []
        while offset < len(body):
            units.append(take_nal(4))
        assert units and (not sync or set(units) & ({5} if self.codec == "h264" else {19, 20}))
        return tag, bool(sync), (width, height)

    def sync(self, tier, reset=0, previous=None):
        deadline = time.monotonic() + 7
        while time.monotonic() < deadline:
            tag, sync, dims = self.pull(tier, reset)
            if tag == 1 and dims != previous:
                assert sync, f"first frame for {dims} was a delta"
                return dims
        raise AssertionError("no sync frame at the expected geometry")


def cancel_with_full_stdout(command, codec, stop):
    reader, writer = os.pipe()
    try:
        with stream(command, stdout=writer) as child:
            records = Records(child, codec, fd=reader)
            records.sync(1)
            os.set_blocking(writer, False)
            # Fill even the last few bytes so a 5-byte idle record will block.
            for size in (4096, 1):
                while True:
                    try:
                        os.write(writer, b"\0" * size)
                    except BlockingIOError:
                        break
            child.stdin.write(b"PULL 1 1\n")
            time.sleep(0.75)
            assert child.poll() is None, "helper exited during the outstanding PULL"
            if stop:
                child.stdin.write(b"STOP\n")
            else:
                child.stdin.close()
            assert child.wait(timeout=2) == 0
    finally:
        os.close(reader)
        os.close(writer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("helper")
    parser.add_argument("window_id")
    parser.add_argument("codec", choices=("h264", "hevc"), default="h264", nargs="?")
    args = parser.parse_args()
    subprocess.run([args.helper, "check"], check=True)
    command = [args.helper, "stream", args.window_id, args.codec]
    with stream(command) as child:
        records = Records(child, args.codec)
        initial = records.sync(1)
        assert max(initial) == 480, "use a window at least 480 pixels on its longest side"
        assert records.pull(1)[0] == 0, "expected idle after initial sync on a static window"
        assert records.sync(1, reset=1) == initial
        assert max(records.sync(0, previous=initial)) == 320
        before_resize = records.sync(1)
        assert before_resize == initial
        input("Resize the window to a different aspect ratio. Then press Return here. ")
        resized = records.sync(1, previous=before_resize)
        assert records.sync(1, reset=1) == resized
        input("Minimize the window and wait two seconds. Then press Return here. ")
        assert records.pull(1, reset=1)[0] == 0, "minimized window returned video"
        input("Restore the window. Then press Return here. ")
        assert records.sync(1) == resized
        child.stdin.write(b"STOP\n")
        assert child.wait(timeout=2) == 0
        assert child.stdout.read() == b"", "received an unsolicited record"
    cancel_with_full_stdout(command, args.codec, stop=True)
    cancel_with_full_stdout(command, args.codec, stop=False)
    print(f"{args.codec}: initial sync, idle, reset, tier, resize, restore, STOP and EOF passed")


if __name__ == "__main__":
    main()
