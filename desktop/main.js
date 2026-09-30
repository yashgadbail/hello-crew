// Electron main process. It owns the agent runtime: it starts the local host
// (./host.js) on a loopback port, shows the call window pointing at it, and
// keeps a tray icon so the agents stay available once the window is closed.
// `electron` is CommonJS, so ESM cannot pick named exports off it. Import the
// default and destructure, which is the supported pattern for an ESM main process.
import electron from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from './host.js';

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } = electron;

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON = join(HERE, 'assets', 'icon.png');

let host = null;
let mainWindow = null;
let settingsWindow = null;
let tray = null;
let quitting = false;

// Agents keep answering with the window closed, so a second launch should focus
// the running instance rather than start a rival host on another port.
if (!app.requestSingleInstanceLock()) app.quit();

function createMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    backgroundColor: '#101218',
    icon: ICON,
    title: 'Hello Crew',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadURL(host.url);

  // Links to the outside world open in the real browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window parks the app in the tray; Quit actually exits.
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => (mainWindow = null));
  return mainWindow;
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 940,
    height: 780,
    backgroundColor: '#101218',
    icon: ICON,
    title: 'Hello Crew settings',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  settingsWindow.loadURL(`${host.url}/settings`);
  settingsWindow.on('closed', () => (settingsWindow = null));
}

function buildTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('Hello Crew');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Hello Crew — ${host.url}`, enabled: false },
      { type: 'separator' },
      { label: 'Open', click: () => createMainWindow() },
      { label: 'Agents and settings', click: () => createSettingsWindow() },
      { label: 'Open in browser', click: () => shell.openExternal(host.url) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => createMainWindow());
}

app.on('second-instance', () => createMainWindow());

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  try {
    // Port 0 lets the OS pick a free one, so two machines or a stray process
    // never collide.
    host = await startHost({ dataDir, port: Number(process.env.PORT) || 0 });
  } catch (err) {
    dialog.showErrorBox('Hello Crew could not start', String(err?.stack || err));
    app.quit();
    return;
  }
  console.log(`[desktop] host on ${host.url}, data in ${dataDir}`);
  buildTray();
  createMainWindow();
});

// The tray is the app: closing every window must not quit it.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
  host?.server?.close();
});
