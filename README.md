# Mini-IDM Video Downloader

Gestionnaire de téléchargement vidéo multi-segments (8 connexions parallèles HTTP `Range` + assembleur/muxeur de flux adaptatifs HLS `.m3u8` / DASH `.mpd` via FFmpeg) accompagné de son extension navigateur Chrome / Edge / Brave (Manifest V3), inspiré de l'architecture d'Internet Download Manager (IDM).

## Structure du projet

- `extension/` : Extension navigateur (Chrome / Edge / Brave Manifest V3)
  - `page-hook.js` : Interception Main World (`fetch`, `XMLHttpRequest`, `HTMLMediaElement.src`)
  - `background.js` : Sniffing réseau `webRequest`, extraction des cookies de session et en-têtes HTTP
  - `content.js` : Bouton flottant **« ⬇ Télécharger cette vidéo »** isolé dans un Shadow DOM au-dessus des lecteurs `<video>`
  - `popup.html` / `popup.js` : Interface popup de contrôle des vidéos détectées et des téléchargements actifs
- `server/` : Moteur local de téléchargement multi-segments et muxing HLS/DASH (`http://127.0.0.1:10010`)
- `start-mini-idm.bat` : Script de lancement rapide sous Windows
