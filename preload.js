'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 内部ページ（pbrowser://）にだけAPIを渡す。外部サイトには何も公開しない。
if (location.protocol === 'pbrowser:') {
  contextBridge.exposeInMainWorld('api', {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, cb) => {
      const handler = (_e, ...args) => cb(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  });
}
