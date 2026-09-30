// ======================================================================
// PROJECT CONTENT. One scene per voice-over section (script.md "## ..." blocks), in order.
//
// Scene API:
//   { name, trans, transDur, zoomAt, draw(ctx, lt, D, T), sfx(add, t0, t1) }
//   lt = local time in the scene (can be slightly <0 or >D during transitions), D = scene length, T = global time
//   trans = how this scene ENTERS: 'iris' | 'push' | 'slide' | 'zoom' | 'zoomOut' | 'wipe' | 'cut'
//   zoomAt = [x, y] point to dive into when the NEXT scene uses trans:'zoom'
//   Sync events to the voice with WT(section, 'слово') -> absolute time of that word.
//   sfx(add): add(time, name, gain, align)
//     name = 'pop'|'whoosh'|'boing'|'thud'|'blip'|'tick'|'click'|'chime'|'crash'|'zap'|'thunder'|'shimmer'|'impact'|'rumble'
//            (taken from the sound library when installed, synthesised otherwise)
//          or 'lib:<id>' — any sound from the library, catalogue: _pipeline/sfx_library/index.md
//          or 'lib:<id>|<offset>|<dur>' — a slice of a long library sound (seconds), with a short fade-out
//     align = 'peak' to put the sound's loudest moment exactly at `time` (hits, whooshes); default: it starts at `time`
// ======================================================================

// Images / frame sequences used by the scenes. Available as IMG.key and seqFrame('key', i) / screenSeq(...)
const ASSETS = {
  images: {
    // logo: '../assets/logo.png',
  },
  sequences: {
    // clip: { pattern: '../assets/clip/f%03d.jpg', count: 120 },
  },
};
// const CAPTION_STYLE = { size: 70, y: 0.765 };   // optional caption overrides; { off: true } hides them
// const THUMBNAIL = { draw(ctx) { ... } };        // cover for the short (node render.js thumb); or { t: 3.2 } to reuse a frame
// const THUMBNAILS = [{ draw }, { draw }, …];      // several cover variants -> out/thumbnail_1.png, _2, …
// const TRANS_WHOOSH = 'lib:whoosh/15-quick-a';  // optional: library whoosh on every transition, peak on the cut

// ---------------------------------------------------------------- 1
const S0 = {
  name: 'Колючий вопрос',
  draw(ctx, lt, D, T) {
    ctx.fillStyle = vgrad(ctx, 0, H, ['#0a0830', '#1a1370', '#3a1d8f']);
    ctx.fillRect(0, 0, W, H);
    stars(ctx, T, 1, 140);
    softGlow(ctx, 540, 800, 700, 'rgba(123,47,247,0.4)');
    hills(ctx, 1250, 70, '#2a1a7a', 3, lt * 6);
    hills(ctx, 1330, 50, '#1f5a4a', 5, -lt * 10);
    const pin = P(lt, 0.1, 0.7, E.outBack);
    const scratch = Math.sin(T * 9) * 0.5;
    drawHog(ctx, 540, 1150, 170 * pin, {
      t: T, look: [0.2, -0.8], armF: 2.3 + scratch * 0.4, armB: -0.7,
      blink: Math.sin(T * 1.3) > 0.99 ? 1 : 0, brows: 0.6,
    });
    for (let i = 0; i < 3; i++) {
      const p = P(T, WT(0, 'зачем') + i * 0.25, 0.4, E.outBackBig);
      ctx.save(); ctx.translate([330, 540, 760][i], 700 + Math.sin(T * 2 + i) * 15); ctx.scale(p, p);
      titleText(ctx, '?', 0, 0, 120, { outline: C.pill });
      ctx.restore();
    }
  },
  sfx(add) { add(WT(0, 'зачем'), 'pop'); add(WT(0, 'зачем') + 0.25, 'pop'); add(WT(0, 'зачем') + 0.5, 'pop'); },
};

// ---------------------------------------------------------------- 2
const S1 = {
  name: 'Броня',
  trans: 'iris',
  draw(ctx, lt, D, T) {
    const tArmor = WT(1, 'броня');
    ctx.fillStyle = vgrad(ctx, 0, H, ['#12306e', '#1e4fa8', '#2f7a5a']);
    ctx.fillRect(0, 0, W, H);
    hills(ctx, 1300, 60, '#2a8a5a', 7, 0);
    const ball = P(T, tArmor - 0.3, 0.4, E.outBack);                 // curls into a ball
    drawHog(ctx, 540, 1180 - ball * 20, 180, { t: T, sq: ball * 0.15, eye: 1 - ball * 0.7, blink: ball, armF: -0.2, look: [0.8, 0] });
    pill(ctx, 540, 380, '5 000 ИГОЛОК', { size: 60, glow: C.purple, scale: P(T, WT(1, 'живая') - 0.2, 0.4, E.outBack) });
  },
  sfx(add) { add(WT(1, 'броня') - 0.3, 'boing'); add(WT(1, 'живая') - 0.2, 'pop'); add(WT(1, 'броня') - 0.1, 'lib:hit/05-impact', 0.5, 'peak'); },
};

const SCENES = [S0, S1];
