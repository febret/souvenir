# Souvenir - an AR Local Media Viewer
Souvenir is a web-based (OpenXR) media viewer for Meta Quest 3 and similar headsets.
It allows the user to load and see local media files (pictures and videos) in
passthrough mode. Users can open and place multiple virtual panels in passthrough mode
with each displaying a separame image, video or automatic slideshow.


-------------------------------------------------------------------------------
## Quick Start
Install dependencies and build the local client once:
```bash
python -m pip install -r requirements.txt
npm install
npm run build
```

Launch the Souvenir HTTPS server using `start.sh`:
```bash
# Optional, set server port. Default to 8000
# SOUVENIR_PORT=5000
SOUVENIR_MEDIA_HOME=/path/to/gallery ./start.sh
```

Optionally provide browser-native commentary audio (WAV, MP3, OGG/Opus,
M4A/AAC, or WebM):

```bash
SOUVENIR_MEDIA_HOME=/path/to/gallery \
SOUVENIR_COMMENTARY_DIR=/path/to/commentary \
./start.sh
```

Optional upload directory name (under `SOUVENIR_MEDIA_HOME`, defaults to
`uploads`):

```bash
SOUVENIR_MEDIA_HOME=/path/to/gallery \
SOUVENIR_UPLOAD_DIRNAME=uploads \
./start.sh
```

On first start, install the generated
`<media home>/.souvenir-certs/ca.pem` certificate authority on the Quest. Then
connect to `https://<server IP>:<port>` in Quest Browser.

See the [illustrated user guide](doc/user-guide.md) for certificate setup,
controls, and troubleshooting.

Contributors can find a server/client overview and component diagrams in the
[architecture guide](doc/architecture.md).

While the server is running, enter `\r` in its console and press Enter to
restart the serving worker and reload code changes. Connected browser clients
remain open and reconnect on the same address.


-------------------------------------------------------------------------------
## Souvenir UI
The souvenir Web UI home shows a configuration panel, letting the user choose:
- what sub-directories of the media home to include 
- whether videos autoplay or not
- slideshow speed
- a button to launch XR mode.

In XR mode, the interface is fully controllable by hand-tracking only (no controllers needed).
A small panel allows the user to create or remove virtual panels. 

Panels are flat screens that the user can move and resize, and that display either
a single image, video or automatic slideshow.

When a new panel is added, it is blank. Pointing at it shows a set of icons on 
its top left corner:
- 🖼️(picture): lets the user choose what picture to display on this panel. It opens 
a search grid rooted at the media home that shows all media files in the current
directory and lets users select subdirectories etc. The user should be able to see 
files by name only, thumbnail or large grid preview. It should be possible to 
sort files by name, modified date, size, or apply a random sort.
- 🔒(lock): locks this panel position, size and orientation. When a panel is locked,
pinch-zoom interactions resize the content within the panel instead of the content,
and dragging actions pan the content instead of moving the panel.
- ↙️(minimize): turns this panel into a small thumbnail. Thumbnails are smaller 
fixed size versions of a panel can be moved around like panels but cannot be resized.
Touching a thumbnail expands it back to a full panel.
- 🍿(slideshow): starts / stops a slideshow on this panel. Media is played back 
in the last selected sort order. 
- 🔍(lock/unlock zoom): when toggled, zoom actions on the panel (ie two hand 
pinch-zoom) zoom the panel's content 


### Panel Interaction
When an image or video is loaded on a panel, clicking on the left or hand size 
of the panel (last 25% of the panel space on either side) load the previous or 
next media in the same directory (respecting the sort order last chosen by the 
user).


-------------------------------------------------------------------------------
## Code Structure
These are the project's main directories:
- `server`: contains the server code (based on FastAPI / uvicorn)
- `app`: contains the client code (vanilla JS/html/css, OpenXR, three.js)
- `test`: contains the test suite for Souvenir
