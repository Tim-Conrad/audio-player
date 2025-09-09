AudioPlayer (SPA)

Play .mp3 files from a folder served by Python's http.server. One folder is treated as a playlist; all .mp3 files are listed and played in order.

Quick start
- Serve this directory on port 9091 (or any port):
  - python3 -m http.server 9091 --directory /home/bee/00_private/git/audio-player
- Open http://localhost:9091/index.html in your browser.
- In "Playlist folder", enter the folder path (e.g. /music/album/) and click Save.

Notes
- The SPA must be served from the same origin/port as the folder due to CORS restrictions.
- Track order follows the server's directory listing order.
 - State is persisted via localStorage; URL params are not used.


