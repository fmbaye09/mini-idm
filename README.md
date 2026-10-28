# 🚀 Mini-IDM Video Downloader

> **Description du dépôt :** Gestionnaire de téléchargement vidéo haute vitesse pour Windows avec extension navigateur (Chrome / Edge / Brave), bouton flottant sur les lecteurs `<video>`, découpage multi-segments (8 connexions parallèles HTTP `Range`) et assemblage automatique des flux adaptatifs HLS (`.m3u8`) / DASH (`.mpd`) en MP4, inspiré de l'architecture d'Internet Download Manager (IDM).

---

## ✨ Fonctionnalités principales

- **🎬 Bouton flottant « ⬇ Télécharger cette vidéo »** : apparaît automatiquement au coin supérieur droit de tout lecteur `<video>` survolé ou en cours de lecture (isolé dans un *Shadow DOM* pour ne jamais être cassé par le CSS des sites).
- **📡 Interception réseau & Main World Hook** :
  - Capture les flux directs (`.mp4`, `.webm`, `.mkv`, `.mov`, `.flv`) via `chrome.webRequest`.
  - Intercepte les appels `fetch()`, `XMLHttpRequest` et `HTMLMediaElement.src` dans la page pour détecter les manifestes de streaming adaptatif **HLS (`.m3u8`)** et **DASH (`.mpd`)**.
  - Analyse automatiquement les *Master Playlists* `.m3u8` (`#EXT-X-STREAM-INF`) pour proposer le **choix de la résolution** (`1080p`, `720p`, `480p`...) directement dans le menu déroulant du bouton flottant.
  - Transmet fidèlement la session du navigateur (**Cookies**, `Referer`, `Origin`, `User-Agent`, `Authorization`) au moteur de téléchargement local.
- **⚡ Moteur de téléchargement hybride** :
  - **Mode Multi-Segments (8x)** : découpe les fichiers directs en **8 segments téléchargés simultanément** (`Range: bytes=start-end`) puis les fusionne à la fin.
  - **Mode Flux Adaptatif HLS / DASH (Muxeur FFmpeg)** : télécharge et assemble sans perte (`-c copy`) les segments `.ts` / `.m4s` et pistes audio/vidéo en un fichier `.mp4` standard prêt à lire.
- **🖥️ Logiciel Windows natif (`Mini-IDM.exe`)** :
  - Interface sombre native Windows (WinForms C#) sans fenêtre de console noire.
  - Démarre et supervise automatiquement le moteur local en tâche de fond silencieuse.
  - **Icône dans la Zone de Notification (System Tray)** près de l'horloge Windows avec notifications bulles au démarrage et à la fin d'un téléchargement, option de lancement au démarrage de Windows, et ouverture directe dans l'Explorateur Windows.

---

## 📂 Architecture du projet

```text
mini-idm/
├── Mini-IDM.exe             # Application Windows native prête à l'emploi
├── start-mini-idm.bat       # Lanceur rapide de Mini-IDM.exe
├── package.json             # Scripts npm (start, build:exe)
├── desktop/
│   ├── MiniIdmApp.cs        # Code source C# de l'application Windows (UI + System Tray)
│   └── app.ico              # Icône Windows de l'application
├── server/
│   └── server.js            # Moteur local (127.0.0.1:10010) : Multi-segments 8x, parseur M3U8, muxeur FFmpeg & Dashboard Web
└── extension/               # Extension Navigateur Chrome / Edge / Brave (Manifest V3)
    ├── manifest.json        # Configuration MV3
    ├── page-hook.js         # Hook Main World (interception XHR / fetch / video.src)
    ├── background.js        # Service Worker (sniffing webRequest, cookies, liaison serveur)
    ├── content.js           # Injection du bouton flottant Shadow DOM sur les balises <video>
    ├── popup.html           # Interface de la popup d'extension
    ├── popup.js             # Logique de la popup (vidéos détectées & progression en direct)
    └── icons/               # Icônes de l'extension (16x16, 48x48, 128x128)
```

---

## 🛠️ Prérequis

1. **Windows 10 ou Windows 11**
2. **[Node.js](https://nodejs.org/)** (v18 ou supérieur, aucune dépendance `npm install` requise — le moteur utilise uniquement les modules natifs de Node.js).
3. **[FFmpeg](https://ffmpeg.org/)** installé et accessible dans le `PATH` Windows (requis pour l'assemblage des flux HLS `.m3u8` et DASH `.mpd`).
   - Installation rapide via Winget dans PowerShell :
     ```powershell
     winget install --id Gyan.FFmpeg
     ```

---

## 📦 Guide d'installation pas-à-pas

### Étape 1 : Cloner le dépôt

```bash
git clone https://github.com/fmbaye09/mini-idm.git
cd mini-idm
```

### Étape 2 : Installer l'extension dans le navigateur (Chrome, Edge ou Brave)

1. Ouvrez votre navigateur et accédez à la page des extensions :
   - **Chrome** : `chrome://extensions`
   - **Edge** : `edge://extensions`
   - **Brave** : `brave://extensions`
2. Activez le commutateur **Mode développeur** (*Developer mode*) en haut à droite.
3. Cliquez sur le bouton **Charger l'extension non empaquetée** (*Load unpacked*).
4. Sélectionnez le sous-dossier **`extension`** situé dans le dossier du projet (`.../mini-idm/extension`).
5. *(Recommandé)* Épinglez l'icône **Mini-IDM** dans la barre d'outils de votre navigateur.

### Étape 3 : Lancer le logiciel Windows `Mini-IDM.exe`

- Double-cliquez sur **`Mini-IDM.exe`** (ou sur `start-mini-idm.bat`).
- L'application s'ouvre et démarre automatiquement le moteur local sur `http://127.0.0.1:10010` en arrière-plan.

---

## 📖 Guide d'utilisation

### 1. Télécharger une vidéo depuis n'importe quel site web (Style IDM)
1. Rendez-vous sur une page contenant une vidéo et lancez la lecture (ou survolez le lecteur vidéo avec la souris).
2. Le bouton flottant **« ⬇ Télécharger cette vidéo »** s'affiche en haut à droite du lecteur `<video>`.
3. Cliquez sur **« ⬇ Télécharger cette vidéo »** (ou sur la flèche **▼** pour choisir la résolution souhaitée, par exemple `1080p`, `720p`, `480p` sur un flux HLS).
4. Le téléchargement démarre immédiatement dans **Mini-IDM** !

### 2. Utiliser la Popup de l'extension
- Cliquez sur l'icône **Mini-IDM** dans la barre d'outils du navigateur :
  - L'onglet **🎬 Vidéos de l'onglet** liste tous les flux vidéo et manifestes détectés sur la page active.
  - L'onglet **⬇ Téléchargements** affiche la progression en temps réel, la vitesse en Mo/s et les boutons **« ▶ Lire »** et **« 📂 »** (afficher dans le dossier).

### 3. Utiliser l'application Windows `Mini-IDM.exe` et la barre système (System Tray)
- **Ajout manuel d'URL** : collez directement un lien `.mp4`, `.webm` ou `.m3u8` dans la barre supérieure et cliquez sur **« ⬇ Télécharger (8x) »**.
- **Gestion des fichiers** : une fois un téléchargement terminé, cliquez sur **« ▶ Lire la vidéo »** pour la lancer dans votre lecteur par défaut ou sur **« 📂 Afficher dans le dossier »** pour la sélectionner dans l'Explorateur Windows (`C:\Users\<VotreNom>\Downloads\Mini-IDM`).
- **Fonctionnement en arrière-plan** :
  - En fermant la fenêtre avec la croix `X`, **Mini-IDM reste actif dans la zone de notification Windows** (à côté de l'horloge) afin d'être toujours prêt à intercepter vos vidéos.
  - Faites un **clic droit** sur l'icône Mini-IDM près de l'horloge pour :
    - Ouvrir la fenêtre principale
    - Télécharger directement l'URL copiée dans le presse-papiers
    - Ouvrir le dossier `Downloads\Mini-IDM`
    - Activer/désactiver **« Lancer automatiquement au démarrage de Windows »**
    - Quitter complètement Mini-IDM

### 4. Dashboard Web intégré
- Lorsque Mini-IDM tourne, vous pouvez également accéder à l'interface web sur **[http://127.0.0.1:10010](http://127.0.0.1:10010)** (qui inclut un lecteur vidéo de test pour vérifier l'apparition du bouton flottant).

---

## 🔧 Recompiler `Mini-IDM.exe` (Optionnel)

Si vous modifiez le code source C# dans [`desktop/MiniIdmApp.cs`](desktop/MiniIdmApp.cs), vous pouvez recompiler l'exécutable Windows sans installer Visual Studio (utilise le compilateur `.NET Framework` inclus nativement dans Windows) :

```bash
npm run build:exe
```
