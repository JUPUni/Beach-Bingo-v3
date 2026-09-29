/* The brand page (packages/brand/index.html): the guidelines, and every file
   in the kit, listed from the build's registry so the page cannot offer a file
   the build did not write. It is written in the language it documents: Ink
   and Teal grounds, Bungee heads, Barlow Condensed text, Cream-bordered cards
   with hard offset shadows, the Fete Labs button recipe, the sea at the foot.
   GENERATED: change this file and re-run scripts/build.mjs. */

import { C, PALETTE } from './palette.mjs';
import { TAGLINE, ENDORSE, URL_TXT } from './compose.mjs';

const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const K = 'kit';

const GROUPS = [
  ['Logo', 'logo', 'The logo, its sticker version for Ink and photographs, one-colour versions, the one-line wordmark, the horizontal lockup, the symbol and the app icon.'],
  ['Solana dApp Store', 'store', 'Listing art for publish.solanamobile.com: the 512 icon, the 1200 × 600 banner and the 1200 × 1200 feature graphic for the Editor’s Choice carousel.'],
  ['Profile pictures', 'pfp', 'Square, with everything that matters inside the centre circle, so a round crop never clips it. The symbol on Teal is the default.'],
  ['X', 'social/x', 'Profile 400 × 400, header 1500 × 500, and posts in Teal and Ink.'],
  ['Instagram', 'social/instagram', 'Profile, square posts in Teal and Ink, portrait and story.'],
  ['Instagram highlight covers', 'social/instagram/highlights', 'Set the highlight’s name in Instagram; the cover carries only the symbol.'],
  ['WhatsApp', 'social/whatsapp', 'Profile picture and status in Teal and Ink.'],
  ['WhatsApp stickers', 'social/whatsapp/stickers', '512 × 512 WebP stickers with a Cream outline for light and dark chats, plus the 96 px tray icon.'],
  ['Colour', 'colour', 'The palette as a swatch sheet. CSS and JSON tokens are in the zip.'],
];

const WEB = [
  ['favicon.svg', 'Browser tab, every modern browser. The symbol without the palm.'],
  ['favicon.ico', 'Legacy browsers and Windows: 16, 32 and 48 in one file.'],
  ['apple-touch-icon.png', 'iPhone and iPad home screen, 180, full bleed (iOS rounds it).'],
  ['icon-192.png', 'Installed web app, 192.'],
  ['icon-512.png', 'Installed web app and splash, 512.'],
  ['icon-maskable-512.png', 'Android adaptive icon for the web app, full bleed, logo inside the safe circle.'],
  ['safari-pinned-tab.svg', 'Safari pinned tab, one colour.'],
  ['og.png', 'Link preview on X, WhatsApp, iMessage, Telegram and Discord, 1200 × 630.'],
];

const ANDROID = [
  ['ic_launcher-playstore-512.png', 'Store icon, 512, full bleed.'],
  ['adaptive-background-432.png', 'Adaptive icon background: Teal and the sea (108 dp).'],
  ['adaptive-foreground-432.png', 'Adaptive icon foreground: the logo inside the 66 dp safe circle.'],
  ['adaptive-monochrome-432.png', 'Themed icon (Android 13+): the logo’s line work.'],
];

export function brandPage({ REG, zipBytes, kitBytes }) {
  const img = (src, alt, w, h, cls = '') => `<img src="${K}/${src}" alt="${esc(alt)}" width="${w}" height="${h}" decoding="async"${cls ? ` class="${cls}"` : ''}>`;
  const reg = (dir, name) => REG.find((a) => a.dir === dir && a.name === name);
  const logoImg = (name, alt, cls) => {
    const a = reg('logo', name);
    return img(`logo/${name}.svg`, alt, a.w, a.h, cls);
  };
  const tile = (ground, inner, cap, cls = '') => `<figure class="tile ${cls}"><div class="tile__g" style="background:${ground}">${inner}</div><figcaption>${cap}</figcaption></figure>`;
  const sec = (id, n, title, body, lede = '') => `<section class="sec" id="${id}" aria-labelledby="${id}-h"><h2 class="sec__h" id="${id}-h"><span>${String(n).padStart(2, '0')}</span>${title}</h2>${lede ? `<p class="lede">${lede}</p>` : ''}${body}</section>`;

  const download = (a) => {
    const base = `${K}/${a.dir}/${a.name}`;
    const prev = a.formats.includes('png') ? 'png' : a.formats.includes('webp') ? 'webp' : a.formats[0];
    const bytes = (fmt) => { try { return kb(kitBytes(`${a.dir}/${a.name}.${fmt}`)); } catch { return ''; } };
    const ground = a.ground || C.sand;
    return `<li class="dl"><a class="dl__p" href="${base}.${prev}" style="background:${ground}"><img src="${base}.${prev}" alt="" loading="lazy" decoding="async" width="${a.w}" height="${a.h}"></a><div class="dl__n">${a.name}</div><div class="dl__m">${a.w} × ${a.h}</div><div class="dl__f">${a.formats.map((fmt) => `<a href="${base}.${fmt}" download>${fmt.toUpperCase()}<small>${bytes(fmt)}</small></a>`).join('')}</div></li>`;
  };
  const tray = (() => { try { return `<li class="dl"><a class="dl__p" href="${K}/social/whatsapp/stickers/tray-96.png" style="background:${C.sand}"><img src="${K}/social/whatsapp/stickers/tray-96.png" alt="" loading="lazy" width="96" height="96"></a><div class="dl__n">tray-96</div><div class="dl__m">96 × 96</div><div class="dl__f"><a href="${K}/social/whatsapp/stickers/tray-96.png" download>PNG<small>${kb(kitBytes('social/whatsapp/stickers/tray-96.png'))}</small></a></div></li>`; } catch { return ''; } })();
  const groups = GROUPS.map(([t, dir, note]) => `<div class="grp"><h3>${t}</h3><p>${note}</p><ul class="dls">${REG.filter((a) => a.dir === dir).map(download).join('')}${dir.endsWith('stickers') ? tray : ''}</ul></div>`).join('');
  const list = (dir, rows) => `<ul class="files">${rows.map(([file, d]) => `<li><a href="${K}/${dir}/${file}" download>${file}</a><span>${d}</span></li>`).join('')}</ul>`;

  const swatches = PALETTE.map(([n, h, role], i) => {
    const dark = h === C.ink;
    const fl = i < 6 ? 'Fete Labs logo kit' : i < 9 ? 'Fete Labs site' : 'Fete Labs kit';
    return `<div class="sw"><div class="sw__c" style="background:${h};color:${dark ? C.cream : C.ink}"><b>${n}</b><span>${h}</span></div><p>${role}</p><small>${fl}</small></div>`;
  }).join('');

  // Each at its real pixel size (inline, so the tile's image rule cannot resize them).
  const at = (src, alt, s) => `<img src="${K}/${src}" alt="${alt}" width="${s}" height="${s}" style="width:${s}px;height:${s}px;max-height:none">`;
  const sizes = [180, 120, 96, 64].map((s) => at('logo/beachbingo-app-icon.svg', `App icon at ${s} px`, s)).join('')
    + at('logo/beachbingo-symbol.svg', 'Symbol at 48 px', 48) + at('logo/beachbingo-symbol.svg', 'Symbol at 32 px', 32) + at('web/favicon-16x16.png', 'Favicon at 16 px', 16);

  const body = `
<a class="skip" href="#main">Skip to content</a>
<nav class="bar" aria-label="Brand kit"><span>Beach Bingo · Brand kit v1</span><a href="beach-bingo-brand-kit.zip" download>Download the kit</a></nav>
<header class="cover">
  <div class="cover__in">
    <p class="kicker">Brand kit v1 · <b>${ENDORSE}</b></p>
    ${logoImg('beachbingo-logo-sticker', 'Beach Bingo', 'cover__logo')}
    <div class="cover__txt">
      <h1 class="paint"><span>Sun up.</span><span>Cards out.</span></h1>
      <p class="lede lede--cover">The logo, colours, type and every file for Beach Bingo: ${URL_TXT}, the Solana dApp Store app for Seeker, and social.</p>
      <a class="btn" href="beach-bingo-brand-kit.zip" download>Download the kit <small>ZIP · ${kb(zipBytes)}</small></a>
    </div>
  </div>
  <div class="sea" aria-hidden="true"></div>
</header>
<main class="wrap" id="main">
${sec('logo', 1, 'Logo', `<div class="g g3">${tile(C.cream, logoImg('beachbingo-logo', 'Beach Bingo logo on Cream'), 'Primary. It carries its own Ink outline, so it holds on Cream, white and Teal.')}${tile(C.ink, logoImg('beachbingo-logo-sticker', 'Beach Bingo sticker logo on Ink'), 'Sticker. A Cream halo round the whole silhouette, for Ink and photographs.')}${tile(C.teal, logoImg('beachbingo-logo', 'Beach Bingo logo on Teal'), 'On Teal, the brand’s own ground.')}</div>`,
    'The idea is the original icon’s: a palm, BEACH stacked on BiNGO, a bingo ball dotting the i, and the sea underneath with a shell on it. The language is Fete Labs’: flat colour from the Fete Labs palette, Bungee lettering, one Ink outline round everything and a hard Ink block shadow. It leans four degrees, the way the Fete Labs test tube leans.')}
${sec('lockups', 2, 'Wordmark and lockup', `<div class="g g2">${tile(C.teal, logoImg('beachbingo-wordmark', 'Beach Bingo wordmark'), 'One line, upright, for headers, nav bars and anywhere the stacked logo is too tall.')}${tile(C.cream, logoImg('beachbingo-lockup-horizontal', 'Beach Bingo horizontal lockup'), 'Horizontal lockup: the symbol, then the wordmark. For app bars and email headers.')}</div>`)}
${sec('symbol', 3, 'Symbol and app icon', `<div class="g g3">${tile(C.sand, logoImg('beachbingo-symbol', 'Beach Bingo symbol', 'sq'), 'The symbol: the ball coming up out of the sea, the palm leaning in. It stands in for the logo below 64 px, and it is the default avatar.')}${tile(C.sand, logoImg('beachbingo-app-icon', 'Beach Bingo app icon', 'sq'), 'The app icon: the stacked logo on the Teal tile, over the sea. The corner is the Fete Labs app-icon corner, 46 of 200.')}${tile(C.ink, `<div class="sizes">${sizes}</div>`, 'App icon at 180, 120, 96 and 64. Below 64 the symbol takes over; at 16 it drops the palm and the number.')}</div>`)}
${sec('mono', 4, 'One colour', `<div class="g g2">${tile(C.cream, logoImg('beachbingo-logo-mono-ink', 'One-colour logo in Ink'), 'Ink on light grounds: stamps, receipts, embroidery, engraving.')}${tile(C.ink, logoImg('beachbingo-logo-mono-cream', 'One-colour logo in Cream'), 'Cream on dark grounds. The line work stays; every fill drops out.')}</div>`)}
${sec('space', 5, 'Clear space and sizes', `<div class="g g2">${tile(C.teal, `<div class="clear">${logoImg('beachbingo-logo', 'Clear space around the logo')}</div>`, 'Keep clear space equal to the height of the ball on every side. Nothing else enters the dashed box.')}<div class="rules"><h3>Minimum sizes</h3><ul><li><b>Logo</b><span>120 px wide on screen, 30 mm in print.</span></li><li><b>Wordmark</b><span>100 px wide, 25 mm.</span></li><li><b>App icon</b><span>64 px. Below that, use the symbol.</span></li><li><b>Symbol</b><span>16 px, without the palm and the number.</span></li></ul></div></div>`)}
${sec('colour', 6, 'Colour', `<div class="g g5">${swatches}</div>`, 'Every colour already belongs to the Fete Labs family. Teal is the ground, Soca Pink and Cream are the words, Gold is the ball and appears once, Surf and Deep are the sea. Ink text reads on every colour here (5.6:1 on Soca Pink, the lowest); Cream text reads only on Ink.')}
${sec('type', 7, 'Type', `<div class="g g3"><div class="ty ty--sign"><span class="ty__n">Bungee · display</span><b>Daub it.</b><p>The wordmark, headings, buttons and numbers on balls. Always caps. The Fete Labs sign face.</p></div><div class="ty ty--paint"><span class="ty__n">Rubik Wet Paint · headline</span><b>Sun up.</b><p>One loud line per layout, caps, line height 0.92, lines alternating Cream and a colour. Never the logo, never below 40 px.</p></div><div class="ty ty--body"><span class="ty__n">Barlow Condensed · body</span><p class="ty__p">Text, captions and controls at 15 px or larger. Labels in caps, tracked 0.3 em: <span class="kicker kicker--inline">Round 42 · Seed committed</span></p></div></div>`, 'All three are Fete Labs faces under the SIL Open Font License, and all three are in the zip. Every word in a kit file is outlined, so no file needs them installed.')}
${sec('language', 8, 'Graphic language', `<div class="g g2"><div class="demo demo--teal"><div class="demo__row"><a class="btn" href="#language">Play free</a><a class="btn btn--pink" href="#language">Join a room</a><a class="btn btn--surf" href="#language">Verify a round</a></div><p>Buttons are the Fete Labs recipe: Bungee caps, a 3 px Cream border, Ink on a saturated fill, and two hard offsets, one down-right and one up-left. They lift on hover and press on tap.</p></div><div class="demo demo--ink"><div class="card"><span class="tagbar">Live room</span><h3>Sunset Hall</h3><p>90-ball · 24 players · next game 19:30 AST</p></div><p>Cards take a 4 px Cream border and a 12 px hard block shadow. Tag bars are solid Lime, Surf or Gold with Ink caps. No gradients, no blur, no glow.</p></div><div class="demo demo--cream"><div class="sparks" aria-hidden="true"><i style="--c:${C.gold}"></i><i style="--c:${C.pink}"></i><i style="--c:${C.lime}"></i><i style="--c:${C.surf}"></i><i style="--c:${C.cream}"></i></div><p>Sparks are small bingo balls, a colour with a Cream face and an Ink outline, scattered with a fixed seed. Keep them off the logo and the words.</p></div><div class="demo demo--sea"><p>The sea is the one pattern: Surf over Deep, each crest in Ink, full bleed across the foot of a layout. It is the icon’s sea, the way Fete Labs uses its three waves.</p><div class="sea sea--demo" aria-hidden="true"></div></div></div>`)}
${sec('voice', 9, 'Voice', `<div class="g g2"><div class="rules"><h3>How it sounds</h3><ul><li><b>Loud and precise</b><span>Short sentences. Concrete nouns: balls, cards, rooms, seeds, minutes.</span></li><li><b>Proof over promises</b><span>Say what can be checked: “Every round’s seed is committed before the first ball.”</span></li><li><b>Free to play</b><span>Coins are play money. Never “win cash”, “payout” or “real money” next to the logo.</span></li><li><b>Island time, stated plainly</b><span>Times in AST with the date. No slang the player has to decode.</span></li></ul></div><div class="rules"><h3>Say this, not that</h3><ul class="say"><li><b>Say</b><span>Sunset Hall opens at 19:30 AST. 90-ball, free.</span></li><li class="no"><b>Not</b><span>Don’t miss out on the ultimate bingo experience!</span></li><li><b>Say</b><span>Round 42 is verified. Check the seed yourself.</span></li><li class="no"><b>Not</b><span>100% fair, trust us.</span></li><li><b>Say</b><span>You’re out of coins. Next free refill in 2 h 10 min.</span></li><li class="no"><b>Not</b><span>Buy now to keep winning big!</span></li></ul></div></div>`)}
${sec('misuse', 10, 'Misuse', `<div class="g g4">${tile(C.sand, `<div style="transform:rotate(4deg)">${logoImg('beachbingo-logo', 'Straightened logo')}</div>`, 'Don’t straighten the lean.', 'x')}${tile(C.sand, `<div style="transform:scaleX(1.35)">${logoImg('beachbingo-logo', 'Stretched logo')}</div>`, 'Don’t stretch or squash it.', 'x')}${tile(C.sand, `<div style="filter:hue-rotate(150deg)">${logoImg('beachbingo-logo', 'Recoloured logo')}</div>`, 'Don’t recolour the words or the sea.', 'x')}${tile(C.ink, logoImg('beachbingo-logo', 'Primary logo on Ink'), 'Don’t put the primary logo on Ink; its outline disappears. Use the sticker.', 'x')}</div>`)}
${sec('files', 11, 'Files', `<p class="lede">Every logo comes as SVG, PNG, WebP and JPG. SVG is vector and scales to any size. PNG and WebP keep the transparency. JPG is flattened onto the ground named in the logo section.</p><p><a class="btn" href="beach-bingo-brand-kit.zip" download>Download the full kit <small>ZIP · ${kb(zipBytes)}</small></a></p>${groups}<div class="grp"><h3>Website and app icons</h3><p>Installed in apps/web/public by the build. Copy them to any other site under the brand.</p>${list('web', WEB)}</div><div class="grp"><h3>Android</h3><p>The WebView shell’s launcher layers, written into android/app/src/main/res by the build.</p>${list('android', ANDROID)}</div><div class="grp"><h3>Fonts</h3><p>SIL Open Font License 1.1. <a href="${K}/fonts/Bungee-Regular.ttf" download>Bungee</a> · <a href="${K}/fonts/RubikWetPaint-Regular.ttf" download>Rubik Wet Paint</a> · <a href="${K}/fonts/BarlowCondensed-Medium.ttf" download>Barlow Condensed Medium</a>, <a href="${K}/fonts/BarlowCondensed-SemiBold.ttf" download>SemiBold</a>, <a href="${K}/fonts/BarlowCondensed-Bold.ttf" download>Bold</a>, <a href="${K}/fonts/BarlowCondensed-ExtraBold.ttf" download>ExtraBold</a></p></div>`)}
</main>
<footer class="foot"><div class="sea sea--foot" aria-hidden="true"></div><div class="foot__in"><span>Beach Bingo · ${ENDORSE}</span><span>${TAGLINE}</span><span>${URL_TXT}</span></div></footer>`;

  return `<!doctype html>
<!-- GENERATED by packages/brand/scripts/build.mjs. Do not hand-edit: change src/page.mjs and re-run. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Beach Bingo Brand Kit</title>
<meta name="description" content="The Beach Bingo logo, colours, type and every logo, app icon, dApp Store, social and web file.">
<meta name="theme-color" content="${C.teal}">
<link rel="icon" href="${K}/web/favicon.svg" type="image/svg+xml">
<style>
@font-face{font-family:"Bungee";font-display:swap;src:url(${K}/fonts/Bungee-Regular.ttf) format("truetype")}
@font-face{font-family:"Rubik Wet Paint";font-display:swap;src:url(${K}/fonts/RubikWetPaint-Regular.ttf) format("truetype")}
@font-face{font-family:"Barlow Condensed";font-weight:500;font-display:swap;src:url(${K}/fonts/BarlowCondensed-Medium.ttf) format("truetype")}
@font-face{font-family:"Barlow Condensed";font-weight:600;font-display:swap;src:url(${K}/fonts/BarlowCondensed-SemiBold.ttf) format("truetype")}
@font-face{font-family:"Barlow Condensed";font-weight:700;font-display:swap;src:url(${K}/fonts/BarlowCondensed-Bold.ttf) format("truetype")}
@font-face{font-family:"Barlow Condensed";font-weight:800;font-display:swap;src:url(${K}/fonts/BarlowCondensed-ExtraBold.ttf) format("truetype")}
/* One look, on purpose: the brand's own grounds, in both OS themes. */
:root{
  color-scheme:dark;
${PALETTE.map(([n, h]) => `  --${n.toLowerCase().replace(/\s+/g, '-')}:${h};`).join('\n')}
  --pink:var(--soca-pink);
  --sign:"Bungee","Arial Black",sans-serif;
  --paint:"Rubik Wet Paint","Bungee","Arial Black",sans-serif;
  --body:"Barlow Condensed","Arial Narrow",sans-serif;
  --gut:clamp(16px,4vw,48px);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--ink);color:var(--cream);font-family:var(--body);font-weight:500;font-size:18px;line-height:1.45;letter-spacing:.01em}
img{max-width:100%;height:auto;display:block}
a{color:var(--surf);text-underline-offset:3px}
a:hover{color:var(--lime)}
:focus-visible{outline:3px solid var(--surf);outline-offset:3px}
.skip{position:absolute;left:-9999px;top:0;z-index:9;background:var(--surf);color:var(--ink);padding:10px 14px;font-family:var(--sign);font-size:14px;text-decoration:none}
.skip:focus{left:16px;top:16px}
.bar{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:12px var(--gut);background:var(--ink);font-family:var(--sign);font-size:13px;text-transform:uppercase;letter-spacing:.04em}
.bar a{color:var(--lime);text-decoration:none}
.kicker{margin:0;font-family:var(--body);font-weight:700;font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:var(--ink)}
.kicker b{color:var(--cream);background:var(--ink);padding:2px 8px;letter-spacing:.2em}
.kicker--inline{display:inline;font-size:.8em;color:var(--lime)}
.cover{position:relative;background:var(--teal);color:var(--ink);overflow:hidden}
.cover__in{max-width:1180px;margin:0 auto;padding:clamp(28px,5vw,64px) var(--gut) clamp(120px,14vw,190px);display:grid;gap:22px;justify-items:start;align-items:center}
.cover__logo{width:min(560px,100%)}
.cover__txt{display:grid;gap:22px;justify-items:start;min-width:0}
@media (min-width:960px){.cover__in{grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);column-gap:56px}.cover__in>.kicker{grid-column:1/-1}}
.paint{margin:0;font-family:var(--paint);font-weight:400;font-size:clamp(46px,7.4vw,96px);line-height:.92;text-transform:uppercase;display:grid}
.paint span:first-child{color:var(--cream)}
.paint span:last-child{color:var(--gold)}
.lede{margin:0;max-width:62ch;font-size:clamp(17px,1.9vw,21px);line-height:1.4;text-wrap:pretty}
.lede--cover{color:var(--ink);font-weight:600}
.btn{--fill:var(--gold);--s1:var(--pink);--s2:var(--surf);--sh:6px;display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;font-family:var(--sign);font-size:clamp(14px,1.6vw,18px);text-transform:uppercase;letter-spacing:.02em;text-decoration:none;color:var(--ink);background:var(--fill);padding:12px 22px;border:3px solid var(--cream);box-shadow:var(--sh) var(--sh) 0 var(--s1),calc(var(--sh)*-1) calc(var(--sh)*-1) 0 var(--s2);transition:transform .13s ease,box-shadow .13s ease;margin:var(--sh)}
.btn small{font-family:var(--body);font-weight:700;font-size:13px;letter-spacing:.08em}
.btn:hover{color:var(--ink);transform:translate(-2px,-2px);box-shadow:calc(var(--sh) + 3px) calc(var(--sh) + 3px) 0 var(--s1),calc((var(--sh) + 3px)*-1) calc((var(--sh) + 3px)*-1) 0 var(--s2)}
.btn:active{transform:translate(2px,2px);box-shadow:2px 2px 0 var(--s1),-2px -2px 0 var(--s2)}
.btn--pink{--fill:var(--pink);--s1:var(--gold);--s2:var(--surf)}
.btn--surf{--fill:var(--surf);--s1:var(--pink);--s2:var(--gold)}
@media (prefers-reduced-motion:reduce){.btn{transition:none}}
.sea{position:absolute;left:0;right:0;bottom:0;height:clamp(70px,9vw,120px);background:
  url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 60' preserveAspectRatio='none'%3E%3Cpath d='M0 14q30-18 60 0t60 0t60 0t60 0V60H0Z' fill='%2322E0F2'/%3E%3Cpath d='M0 32q30-16 60 0t60 0t60 0t60 0V60H0Z' fill='%230F9BD6'/%3E%3Cpath d='M0 32q30-16 60 0t60 0t60 0t60 0' fill='none' stroke='%230E0818' stroke-width='3'/%3E%3Cpath d='M0 14q30-18 60 0t60 0t60 0t60 0' fill='none' stroke='%230E0818' stroke-width='3'/%3E%3C/svg%3E") repeat-x left bottom/clamp(240px,26vw,360px) 100%}
.wrap{max-width:1180px;margin:0 auto;padding-block:clamp(40px,6vw,80px);padding-inline:var(--gut);display:grid;gap:clamp(56px,7vw,88px)}
.sec{display:grid;gap:22px;min-width:0}
.sec__h{margin:0;display:flex;align-items:baseline;gap:14px;font-family:var(--sign);font-weight:400;font-size:clamp(26px,4vw,44px);line-height:1.05;text-transform:uppercase;color:var(--cream);border-top:3px solid var(--teal);padding-top:16px;text-wrap:balance}
.sec__h span{font-family:var(--body);font-weight:700;font-size:14px;letter-spacing:.3em;color:var(--lime)}
.g{display:grid;gap:24px}
.g2{grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.g4{grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))}
.g5{grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))}
.tile{margin:0;display:grid;gap:10px;min-width:0;align-content:start}
.tile__g{min-height:280px;display:grid;place-items:center;padding:clamp(20px,3vw,36px);border:4px solid var(--cream);box-shadow:10px 10px 0 var(--teal);overflow:hidden}
.tile__g img{max-height:260px;width:auto}
.tile__g img.sq{max-height:220px;border-radius:0}
.tile figcaption{font-size:16px;line-height:1.4;color:var(--cream)}
.tile.x .tile__g{position:relative}
.tile.x .tile__g::after{content:"";position:absolute;inset:12px;background:linear-gradient(to top right,transparent calc(50% - 3px),var(--pink) calc(50% - 3px),var(--pink) calc(50% + 3px),transparent calc(50% + 3px))}
.sizes{display:flex;flex-wrap:wrap;align-items:flex-end;gap:18px}
.clear{outline:3px dashed var(--ink);outline-offset:18px;padding:0;max-width:78%}
.rules{display:grid;gap:14px;align-content:start;padding:26px;border:4px solid var(--cream);background:var(--ink);box-shadow:10px 10px 0 var(--pink)}
.rules h3{margin:0;font-family:var(--sign);font-weight:400;font-size:22px;text-transform:uppercase;color:var(--gold)}
.rules ul{margin:0;padding:0;list-style:none;display:grid;gap:12px}
.rules li{display:grid;gap:2px}
.rules li b{font-family:var(--body);font-weight:800;font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:var(--lime)}
.say li.no b{color:var(--pink)}
.sw{display:grid;gap:8px;align-content:start;min-width:0}
.sw__c{min-height:150px;display:grid;align-content:end;gap:2px;padding:16px;border:4px solid var(--cream)}
.sw__c b{font-family:var(--sign);font-weight:400;font-size:18px;text-transform:uppercase}
.sw__c span{font-weight:700;font-size:15px;letter-spacing:.08em;font-variant-numeric:tabular-nums}
.sw p{margin:0;font-size:16px;line-height:1.35}
.sw small{font-weight:700;font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--surf)}
.ty{display:grid;gap:12px;align-content:start;padding:26px;border:4px solid var(--cream);min-width:0}
.ty__n{font-weight:700;font-size:13px;letter-spacing:.3em;text-transform:uppercase}
.ty b{font-weight:400;line-height:1;text-transform:uppercase}
.ty p{margin:0}
.ty--sign{background:var(--pink);color:var(--ink)}
.ty--sign b{font-family:var(--sign);font-size:clamp(40px,6vw,64px)}
.ty--paint{background:var(--ink);color:var(--cream)}
.ty--paint b{font-family:var(--paint);font-size:clamp(46px,7vw,76px);color:var(--gold)}
.ty--body{background:var(--cream);color:var(--ink)}
.ty__p{font-size:24px;line-height:1.35}
.demo{display:grid;gap:18px;align-content:start;padding:28px;border:4px solid var(--cream);min-width:0;position:relative;overflow:hidden}
.demo p{margin:0}
.demo__row{display:flex;flex-wrap:wrap;gap:14px}
.demo--teal{background:var(--teal);color:var(--ink)}
.demo--ink{background:var(--ink)}
.demo--cream{background:var(--cream);color:var(--ink)}
.demo--sea{background:var(--teal);color:var(--ink);min-height:230px;padding-bottom:110px}
.card{display:grid;gap:6px;padding:20px 22px;border:4px solid var(--cream);background:var(--ink);box-shadow:12px 12px 0 var(--surf);max-width:360px}
.card h3{margin:0;font-family:var(--sign);font-weight:400;font-size:26px;text-transform:uppercase}
.card p{margin:0;color:var(--cream)}
.tagbar{justify-self:start;background:var(--lime);color:var(--ink);font-weight:800;font-size:13px;letter-spacing:.2em;text-transform:uppercase;padding:3px 10px}
.sparks{display:flex;gap:18px;flex-wrap:wrap}
.sparks i{width:34px;height:34px;border-radius:50%;background:radial-gradient(circle,var(--cream) 0 44%,var(--c) 45%);border:5px solid var(--ink);box-shadow:5px 5px 0 var(--ink)}
.grp{display:grid;gap:12px;padding-top:6px;min-width:0}
.grp h3{margin:0;font-family:var(--sign);font-weight:400;font-size:22px;text-transform:uppercase;color:var(--gold)}
.grp p{margin:0;max-width:70ch;font-size:16px}
.dls{list-style:none;margin:0;padding:0;display:grid;gap:22px;grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr))}
.dl{display:grid;gap:4px;min-width:0;align-content:start}
.dl__p{display:grid;place-items:center;height:170px;padding:12px;border:3px solid var(--cream);margin-bottom:6px}
.dl__p img{max-height:100%;width:auto;object-fit:contain}
.dl__n{font-weight:700;font-size:15px;overflow-wrap:anywhere}
.dl__m{font-size:14px;color:var(--surf);font-variant-numeric:tabular-nums}
.dl__f{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.dl__f a{display:inline-flex;align-items:baseline;gap:5px;min-height:32px;padding:5px 10px;border:2px solid var(--cream);color:var(--cream);font-family:var(--sign);font-size:12px;text-decoration:none}
.dl__f a small{font-family:var(--body);font-weight:600;font-size:11px}
.dl__f a:hover{background:var(--lime);color:var(--ink);border-color:var(--lime)}
.files{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.files li{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:16px}
.files a{font-weight:700;min-width:250px}
.foot{position:relative;background:var(--teal);color:var(--ink);padding-top:clamp(80px,9vw,120px)}
.foot .sea--foot{top:0;bottom:auto;transform:scaleY(-1)}
.foot__in{max-width:1180px;margin:0 auto;padding:22px var(--gut) 30px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px 24px;font-weight:800;font-size:14px;letter-spacing:.24em;text-transform:uppercase}
@media (max-width:520px){.tile__g{min-height:200px}.files a{min-width:0}}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
