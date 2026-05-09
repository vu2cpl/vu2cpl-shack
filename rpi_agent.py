from http.server import BaseHTTPRequestHandler, HTTPServer
import subprocess, json

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/reboot':
            self._ok('rebooting')
            subprocess.Popen(['sudo', 'reboot'])
        elif self.path == '/shutdown':
            self._ok('shutting down')
            subprocess.Popen(['sudo', 'shutdown', '-h', 'now'])
        else:
            self.send_response(404); self.end_headers()
    def _ok(self, msg):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'status': msg}).encode())
    def log_message(self, *args): pass

HTTPServer(('0.0.0.0', 7799), Handler).serve_forever()
