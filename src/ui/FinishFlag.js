const $ = (id) => document.getElementById(id);

const FLAG_TIME = 2600; // ms the flag waves before the fade
const FADE_TIME = 700; // ms, must match the fader's CSS transition

/**
 * "Race over" sequence: a waving chequered flag on a pole, then a fade through black into
 * whatever comes next (the podium ceremony). The flag is drawn on a canvas as a grid of
 * quads displaced by a travelling wave, with shading from the wave's slope.
 */
export class FinishFlag {
  constructor() {
    this.root = $('race-over');
    this.canvas = $('flag-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.fader = $('fader');
    this.active = false;
    this._timers = [];
    this._draw = this._draw.bind(this);
  }

  /** Show the flag, fade to black, call `atBlack()` (switch scenes), then fade back in. */
  play(atBlack) {
    this.cancel();
    this.active = true;
    this.root.classList.remove('hidden');
    this.root.classList.add('flex');
    this._start = performance.now();
    this._raf = requestAnimationFrame(this._draw);
    this._timers.push(setTimeout(() => this.fader.classList.replace('opacity-0', 'opacity-100'), FLAG_TIME));
    this._timers.push(setTimeout(() => {
      this._hideFlag();
      if (atBlack) atBlack();
      this.fader.classList.replace('opacity-100', 'opacity-0');
      this.active = false;
    }, FLAG_TIME + FADE_TIME + 80));
  }

  cancel() {
    for (const t of this._timers) clearTimeout(t);
    this._timers.length = 0;
    this._hideFlag();
    this.fader.classList.replace('opacity-100', 'opacity-0');
    this.active = false;
  }

  _hideFlag() {
    cancelAnimationFrame(this._raf);
    this.root.classList.add('hidden');
    this.root.classList.remove('flex');
  }

  _draw(now) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const t = (now - this._start) / 1000;
    ctx.clearRect(0, 0, W, H);

    // Pole
    const poleX = 60;
    ctx.fillStyle = '#d9d9d9';
    ctx.fillRect(poleX - 7, 20, 14, H - 30);
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.arc(poleX, 20, 12, 0, Math.PI * 2);
    ctx.fill();

    // Flag: a grid of cells, each corner displaced by a travelling wave that grows away
    // from the pole. Shading follows the wave's slope so folds read as light and shadow.
    const cols = 10, rows = 7;
    const fw = W - poleX - 30, fh = 210;
    const x0 = poleX + 7, y0 = 32;
    const amp = 22;
    const at = (c, r) => {
      const u = c / cols;
      const phase = u * 7 - t * 7;
      const dy = Math.sin(phase) * amp * u + Math.sin(phase * 0.5 + r * 0.4) * 5 * u;
      const dx = -Math.abs(Math.sin(phase)) * 6 * u; // cloth bunches up a little in the folds
      return [x0 + u * fw + dx, y0 + (r / rows) * fh + dy];
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = at(c, r), b = at(c + 1, r), d = at(c, r + 1), e = at(c + 1, r + 1);
        const slope = Math.cos((c + 0.5) / cols * 7 - t * 7); // −1..1
        const light = 0.78 + 0.22 * slope;
        const dark = (r + c) % 2 === 0;
        const v = Math.round((dark ? 22 : 245) * light);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.lineTo(e[0], e[1]);
        ctx.lineTo(d[0], d[1]);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = ctx.fillStyle; // hide hairline seams between cells
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    this._raf = requestAnimationFrame(this._draw);
  }
}
