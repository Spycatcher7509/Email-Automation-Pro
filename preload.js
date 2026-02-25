const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  
  // Email operations
  sendNow: (payload) => ipcRenderer.invoke('send-now', payload),
  
  // Schedule operations
  saveSchedule: (schedule) => ipcRenderer.invoke('save-schedule', schedule),
  getSchedules: () => ipcRenderer.invoke('get-schedules'),
  updateSchedule: (schedule) => ipcRenderer.invoke('update-schedule', schedule),
  saveSchedules: (schedules) => ipcRenderer.invoke('save-schedules', schedules),
  
  // Multi-folder operations
  getFolderPairs: () => ipcRenderer.invoke('get-folder-pairs'),
  saveFolderPairs: (pairs) => ipcRenderer.invoke('save-folder-pairs', pairs),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  
  // Transcription
  transcribeAudio: (options) => ipcRenderer.invoke('transcribe-audio', options),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),

  // Auth
  sendResetEmail: (email) => ipcRenderer.invoke('send-reset-email', email),

  // PQC recipient keys
  getRecipientKeys: () => ipcRenderer.invoke('get-recipient-keys'),
  saveRecipientKey: (entry) => ipcRenderer.invoke('save-recipient-key', entry),

  // PQC decrypt
  decryptEnvelope: (paths) => ipcRenderer.invoke('decrypt-envelope', paths)
});
