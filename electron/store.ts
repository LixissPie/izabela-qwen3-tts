import Store from 'electron-store'
import path from 'node:path'

const storeOptions = process.versions.electron
    ? {}
    : { cwd: path.join(process.env.APPDATA ?? process.cwd(), 'izabela-custom-server') }

export const store = new Store(storeOptions)
