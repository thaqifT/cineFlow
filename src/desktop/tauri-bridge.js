import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

window.cineflow = {
  startBridge: () => invoke('start_bridge'),
  getState: () => invoke('get_state'),
  command: (command, options) => invoke('command', { command, start: options?.start ?? null }),
  saveCutscene: content => invoke('save_cutscene', { content }),
  openCutscene: () => invoke('open_cutscene'),
  exportPlugin: () => invoke('export_plugin'),
  listTakes: () => invoke('list_takes'),
  setActiveCutscene: cutscene => invoke('set_active_cutscene', { cutscene }),
  onState: callback => {
    let unlisten;
    const ready = listen('bridge-state', event => callback(event.payload)).then(stop => {
      unlisten = stop;
    });
    return () => { if (unlisten) unlisten(); else void ready.then(stop => stop()); };
  },
  onPluginPreview: callback => {
    let unlisten;
    const ready = listen('plugin-preview', event => callback(event.payload)).then(stop => {
      unlisten = stop;
    });
    return () => { if (unlisten) unlisten(); else void ready.then(stop => stop()); };
  },
  onMotion: callback => {
    let unlisten;
    const ready = listen('phone-motion', event => callback(event.payload)).then(stop => {
      unlisten = stop;
    });
    return () => { if (unlisten) unlisten(); else void ready.then(stop => stop()); }
  },
  onPreview: callback => {
    let unlisten;
    const ready = listen('plugin-preview', event => callback(event.payload)).then(stop => {
      unlisten = stop;
    });
    return () => { if (unlisten) unlisten(); else void ready.then(stop => stop()); }
  }
};
