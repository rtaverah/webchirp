"""Servidor local para las pruebas: sirve webchirp/ y recibe resultados por POST /__result
(se guardan en el archivo indicado, una línea JSON por mensaje).
Uso: python3 tests/serve.py [puerto] [archivo_resultados]"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/webchirp-results.jsonl'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n)
        with open(OUT, 'ab') as f:
            f.write(body.replace(b'\n', b' ') + b'\n')
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
