"""Serve only the output directory on localhost, including MP4 byte ranges."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse, re
ROOT=Path(__file__).resolve().parent.parent/'output'
p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=4355);a=p.parse_args()
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,*args):pass
    def send_head(self):
        target=Path(self.translate_path(self.path))
        if target.is_file() and self.headers.get('Range'):
            match=re.fullmatch(r'bytes=(\d+)-(\d*)',self.headers['Range'])
            if not match:return super().send_head()
            size=target.stat().st_size;start=int(match[1]);end=min(size-1,int(match[2]) if match[2] else size-1)
            if start>end:self.send_error(416);return None
            self.send_response(206);self.send_header('Content-Type',self.guess_type(str(target)));self.send_header('Content-Length',str(end-start+1));self.send_header('Content-Range',f'bytes {start}-{end}/{size}');self.send_header('Accept-Ranges','bytes');self.end_headers()
            f=target.open('rb');f.seek(start);self.remaining=end-start+1;return f
        return super().send_head()
    def copyfile(self,source,out):
        if not hasattr(self,'remaining'):return super().copyfile(source,out)
        while self.remaining:
            block=source.read(min(65536,self.remaining))
            if not block:break
            out.write(block);self.remaining-=len(block)
        del self.remaining
ThreadingHTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
