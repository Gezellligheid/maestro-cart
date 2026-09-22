const $ = (id) => document.getElementById(id);

/** Settings overlay: master / music / effects volume and mute. Opened from menu, lobby and HUD. */
export class Settings {
  constructor(audio) {
    this.audio = audio;
    this.root = $('settings');
    for (const btn of document.querySelectorAll('[data-open-settings]')) {
      btn.addEventListener('click', () => this.open());
    }
    $('btn-settings-close').addEventListener('click', () => this.close());
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });

    for (const kind of ['master', 'music', 'sfx']) {
      const input = $(`vol-${kind}`);
      input.addEventListener('input', () => {
        this.audio.set(kind, Number(input.value) / 100);
        this._label(kind);
      });
    }
    $('vol-mute').addEventListener('change', (e) => this.audio.set('muted', e.target.checked));
  }

  _label(kind) {
    $(`vol-${kind}-v`).textContent = `${Math.round(this.audio.settings[kind] * 100)}%`;
  }

  /** Sync the controls with the current audio settings. */
  refresh() {
    for (const kind of ['master', 'music', 'sfx']) {
      $(`vol-${kind}`).value = String(Math.round(this.audio.settings[kind] * 100));
      this._label(kind);
    }
    $('vol-mute').checked = this.audio.settings.muted;
  }

  open() {
    this.audio.init();
    this.refresh();
    this.root.classList.remove('hidden');
    this.root.classList.add('grid');
  }

  close() {
    this.root.classList.add('hidden');
    this.root.classList.remove('grid');
  }

  toggle() {
    if (this.visible) this.close();
    else this.open();
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }
}
