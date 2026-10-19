"""urllib_send：用本机的 HTTP 服务器测试（不连外网）。"""

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from arkrecord_backend.hg import urllib_send


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/target")
            self.end_headers()
            return
        status = 404 if self.path == "/missing" else 200
        body = b'{"path":"' + self.path.encode() + b'"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Set-Cookie", "a=1")
        self.send_header("Set-Cookie", "ak-user-center=FAKE")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        length = int(self.headers["Content-Length"])
        body = self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", self.headers["Content-Type"])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture(autouse=True)
def bypass_proxy(monkeypatch):
    # 本机装了代理（环境变量或系统设置）时，本机地址也不要走代理
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")


@pytest.fixture(scope="module")
def base_url():
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_ok_keeps_all_set_cookie_headers(base_url):
    response = urllib_send("GET", f"{base_url}/ok", {"accept": "application/json"}, None, 5)
    assert response.status == 200
    cookies = [v for k, v in response.headers if k.lower() == "set-cookie"]
    assert cookies == ["a=1", "ak-user-center=FAKE"]
    assert response.body == b'{"path":"/ok"}'


def test_error_status_is_returned_not_raised(base_url):
    response = urllib_send("GET", f"{base_url}/missing", {}, None, 5)
    assert response.status == 404 and response.body == b'{"path":"/missing"}'


def test_redirects_are_not_followed(base_url):
    response = urllib_send("GET", f"{base_url}/redirect", {}, None, 5)
    assert response.status == 302


def test_post_body(base_url):
    response = urllib_send("POST", f"{base_url}/echo", {"content-type": "application/json"}, b'{"a":1}', 5)
    assert response.status == 200 and response.body == b'{"a":1}'
