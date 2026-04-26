import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, protocol } from 'electron'
import type { Protocol } from 'electron'
import path from 'path'
import { startExpressServer } from './server'
import { fileURLToPath, URL } from 'url'
import { dirname } from 'path'
import { store } from './store.ts'
import { readFile } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const IS_DEV = Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.NODE_ENV === 'development'

declare global {
    namespace Electron {
        interface App {
            isQuitting: boolean;
        }
    }
}

app.isQuitting = false;

function devLog(event: string, data?: Record<string, unknown>) {
    if (!IS_DEV) {
        return
    }

    console.log(`[dev:electron] ${event}`, data ?? '')
}

// Ensure only one instance of the app can run at a time
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    devLog('single-instance:lock-failed')
    console.log('Another instance is already running. Quitting...');
    app.quit();
} else {
    app.on('second-instance', () => {
        devLog('single-instance:second-instance')
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// Keep a global reference of objects to prevent garbage collection
let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null

function setAutoLaunch(enabled: boolean) {
    devLog('auto-launch:set', { enabled })
    app.setLoginItemSettings({
        openAtLogin: enabled,
        path: app.getPath('exe')
    })
    store.set('autoLaunch', enabled)
}

export function createProtocol(scheme: string, customProtocol?: Protocol) {
    devLog('protocol:register', { scheme })
    ;(customProtocol || protocol).registerBufferProtocol(
        scheme,
        (request, respond) => {
            let pathName = new URL(request.url).pathname
            pathName = decodeURI(pathName) // Needed in case URL contains spaces

            devLog('protocol:request', {
                scheme,
                url: request.url,
                pathName,
            })

            readFile(path.join(__dirname, '../dist', pathName), (error, data) => {
                if (error) {
                    devLog('protocol:error', {
                        scheme,
                        pathName,
                        error: error.message,
                    })
                    console.error(
                        `Failed to read ${pathName} on ${scheme} protocol`,
                        error,
                    )
                }
                const extension = path.extname(pathName).toLowerCase()
                let mimeType = ''

                if (extension === '.js') {
                    mimeType = 'text/javascript'
                } else if (extension === '.html') {
                    mimeType = 'text/html'
                } else if (extension === '.css') {
                    mimeType = 'text/css'
                } else if (extension === '.svg' || extension === '.svgz') {
                    mimeType = 'image/svg+xml'
                } else if (extension === '.json') {
                    mimeType = 'application/json'
                } else if (extension === '.wasm') {
                    mimeType = 'application/wasm'
                }

                devLog('protocol:respond', {
                    scheme,
                    pathName,
                    mimeType,
                    bytes: data?.length,
                })
                respond({ mimeType, data })
            })
        },
    )
}

function createWindow() {
    devLog('window:create:start', {
        devServerUrl: process.env.VITE_DEV_SERVER_URL,
    })

    mainWindow = new BrowserWindow({
        show: !!process.env.VITE_DEV_SERVER_URL,
        width: 600,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        icon: process.env.VITE_DEV_SERVER_URL
            ? path.join(process.cwd(), 'public', '256x256.png')
            : path.join(process.resourcesPath, 'public', '256x256.png'),
    })
    mainWindow.setMenu(null)
    if (process.env.VITE_DEV_SERVER_URL) {
        devLog('window:load-url', { url: process.env.VITE_DEV_SERVER_URL })
        mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
        devLog('window:open-devtools')
        mainWindow.webContents.openDevTools({
            mode: 'undocked'
        })
    } else {
        createProtocol('app')
        devLog('window:load-url', { url: 'app://./index.html' })
        mainWindow.loadURL(`app://./index.html`)
        // mainWindow.webContents.openDevTools({
        //     mode: 'undocked'
        // })
    }

    mainWindow.webContents.on('did-start-loading', () => {
        devLog('webcontents:did-start-loading')
    })
    mainWindow.webContents.on('did-finish-load', () => {
        devLog('webcontents:did-finish-load', {
            url: mainWindow?.webContents.getURL(),
        })
    })
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        devLog('webcontents:did-fail-load', {
            errorCode,
            errorDescription,
            validatedURL,
        })
    })
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        devLog('renderer:console-message', {
            level,
            message,
            line,
            sourceId,
        })
    })

    mainWindow.on('close', (event) => {
        devLog('window:close', {
            isQuitting: app.isQuitting,
        })
        if (!app.isQuitting) {
            event.preventDefault()
            mainWindow?.hide()
            return false
        }
        return true
    })

    mainWindow.on('closed', () => {
        devLog('window:closed')
        mainWindow = null
    })
}

function createTray() {
    devLog('tray:create:start')
    const iconPath = process.env.VITE_DEV_SERVER_URL
        ? path.join(process.cwd(), 'public', '256x256.png')
        : path.join(process.resourcesPath, 'public', '256x256.png')

    const icon = nativeImage.createFromPath(iconPath)
    tray = new Tray(icon)
    tray.setToolTip('Izabela Next - Custom Server')
    tray.on('click', () => {
        devLog('tray:click')
        if (mainWindow === null) {
            createWindow()
        } else {
            mainWindow.show()
        }
    })
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open Window',
            click: () => {
                devLog('tray:menu:open-window')
                if (mainWindow === null) {
                    createWindow()
                } else {
                    mainWindow.show()
                }
            }
        },
        {
            label: 'Auto Launch',
            type: 'checkbox',
            checked: store.get('autoLaunch', true) as boolean,
            click: (menuItem) => {
                devLog('tray:menu:auto-launch', { checked: menuItem.checked })
                setAutoLaunch(menuItem.checked)
            }
        },
        { 
            label: 'Restart',
            click: () => {
                devLog('tray:menu:restart')
                app.isQuitting = true;
                app.relaunch();
                app.exit(0);
            } 
        },
        { type: 'separator' },
        { 
            label: 'Quit', 
            click: () => {
                devLog('tray:menu:quit')
                app.isQuitting = true
                app.quit()
            } 
        }
    ])

    tray.setContextMenu(contextMenu)
}

ipcMain.handle('electron-store-get', async (_, key) => {
    devLog('ipc:electron-store-get', { key })
    return store.get(key);
});

ipcMain.handle('electron-store-set', async (_, { key, value }) => {
    devLog('ipc:electron-store-set', { key, value })
    store.set(key, value);
    return true;
});

ipcMain.handle('electron-store-delete', async (_, key) => {
    devLog('ipc:electron-store-delete', { key })
    store.delete(key);
    return true;
});

ipcMain.handle('electron-store-has', async (_, key) => {
    devLog('ipc:electron-store-has', { key })
    return store.has(key);
});

app.whenReady().then(() => {
    devLog('app:ready')
    createWindow()
    createTray()
    startExpressServer()

    const shouldAutoLaunch = store.get('autoLaunch', true) as boolean
    devLog('auto-launch:loaded', { enabled: shouldAutoLaunch })
    setAutoLaunch(shouldAutoLaunch)

    app.on('activate', () => {
        devLog('app:activate')
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

app.on('window-all-closed', () => {
    devLog('app:window-all-closed', { platform: process.platform })
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('before-quit', () => {
    devLog('app:before-quit')
    app.isQuitting = true
})
