import { formatTime } from '../game/RaceManager.js';
import { seedToCode } from '../game/Records.js';

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "Your stats" overlay from the main menu: career numbers and recent track records. */
export class StatsPanel {
  constructor(records) {
    this.records = records;
    this.root = $('stats-panel');
    $('btn-stats').addEventListener('click', () => this.open());
    $('btn-stats-close').addEventListener('click', () => this.close());
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
  }

  open() {
    const s = this.records.stats;
    const cell = (label, value) => `<div class="rounded-xl bg-black/30 px-3 py-2"><p class="text-[10px] font-bold uppercase tracking-widest text-white/50">${label}</p><p class="title text-2xl">${value}</p></div>`;
    $('stats-grid').innerHTML = [
      cell('Races', s.races),
      cell('Wins', s.wins),
      cell('Podiums', s.podiums),
      cell('Coins banked', s.coins),
      cell('Records broken', s.records),
      cell('Fastest lap', s.bestLap ? formatTime(s.bestLap.ms) : '—'),
    ].join('');
    const tracks = this.records.recentTracks(8);
    $('stats-tracks').innerHTML = tracks.length
      ? tracks.map((t) => `<li class="flex items-center gap-2 rounded-lg bg-black/25 px-3 py-1.5 text-sm">
          <span class="min-w-0 flex-1 truncate font-bold">${escapeHtml(t.name || 'Track')}</span>
          <span class="font-mono text-[11px] text-white/45">${seedToCode(t.seed)}</span>
          <span class="w-16 text-right font-mono tabular-nums">${t.lap != null ? formatTime(t.lap) : '—'}</span>
          <span class="w-16 text-right font-mono tabular-nums text-white/70">${t.race != null ? formatTime(t.race) : '—'}</span>
        </li>`).join('')
      : '<li class="text-sm text-white/50">No races yet. Go set some records!</li>';
    this.root.classList.remove('hidden');
    this.root.classList.add('grid');
  }

  close() {
    this.root.classList.add('hidden');
    this.root.classList.remove('grid');
  }
}
