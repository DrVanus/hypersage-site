// Exercise the actual scripts with only their small DOM surface stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', 'nightshelf');
const catalogSource = fs.readFileSync(path.join(root, 'shared-book-catalog.js'), 'utf8');
const handler = fs.readFileSync(path.join(root, 'shared-book.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function run(search) {
  const elements = Object.fromEntries([
    'shared-book', 'shared-book-title', 'shared-book-author',
    'shared-book-description', 'shared-book-edition', 'shared-book-open',
  ].map(id => [id, { hidden: true, textContent: '', href: '' }]));
  const context = {
    URLSearchParams,
    window: { location: { search } },
    document: { title: 'Nightshelf', getElementById: id => elements[id] },
  };
  vm.createContext(context);
  vm.runInContext(catalogSource, context);
  vm.runInContext(handler, context);
  assert.equal(context.window.location.search, search, 'Must not navigate automatically');
  return { elements, context };
}

const catalog = run('').context.window.nightshelfSharedBooks;
for (const [id, book] of Object.entries(catalog)) {
  const { elements, context } = run('?book=' + encodeURIComponent(id));
  assert.equal(elements['shared-book'].hidden, false);
  assert.equal(elements['shared-book-title'].textContent, book.title);
  const original = book.kind === 'original';
  assert.equal(elements['shared-book-author'].textContent, original ? 'A Nightshelf Original' : 'by ' + book.author);
  if (original) {
    assert.match(book.disclosure, /Created with AI/, id + ' must carry the AI disclosure');
    assert.ok(elements['shared-book-description'].textContent.includes(book.disclosure), id + ' card must disclose AI');
  } else {
    assert.equal(elements['shared-book-description'].textContent, book.blurb);
  }
  assert.equal(elements['shared-book-open'].href, 'nightshelf://book/' + id);
  assert.equal(elements['shared-book-edition'].textContent,
    book.freeTier ? 'Free on Nightshelf' : 'Included with Nightshelf Pro');
  assert.equal(context.document.title, original
    ? book.title + ' — a Nightshelf Original'
    : book.title + ' by ' + book.author + ' — Nightshelf');
}
const rejected = ['?book=peter_pan', '?book=irish_fairy_tales', '?book=pinocchio', '', '?book=', '?book=missing', '?book=custom_private',
  '?book=__proto__', '?book=constructor', '?book=toString',
  '?book=%3Cscript%3Ealert(1)%3C/script%3E', '?book=javascript%3Aalert(1)',
  '?book=peter_pan&book=wind_in_willows', '?book=Peter_Pan', '?book=peter_pan%2Fevil'];
for (const search of rejected) {
  const { elements, context } = run(search);
  assert.equal(elements['shared-book'].hidden, true, search);
  assert.equal(elements['shared-book-open'].href, '', search);
  assert.equal(context.document.title, 'Nightshelf', search);
}
assert.match(html, /id="shared-book"[^>]*hidden/);
assert.match(html, /https:\/\/apps\.apple\.com\/app\/id6792761643/);
for (const id of Object.keys(run('').elements)) assert.ok(html.includes('id="' + id + '"'), id);
// Shelf counts are the classics; selected tales and Originals carry a kind.
const books = Object.values(catalog).filter(book => !book.kind);
const originals = Object.values(catalog).filter(book => book.kind === 'original');
const selections = Object.values(catalog).filter(book => book.kind === 'selection');
assert.equal(books.length, 93, 'all 93 full-volume routes remain available');
assert.equal(selections.length, 24, 'all twenty-four traditional selection routes remain available');
assert.equal(originals.length, 11, 'all eleven prepared Originals have a shared route');
assert.equal(originals.filter(book => book.freeTier).length, 5, 'five Originals are free');
assert.equal(originals.filter(book => !book.freeTier).length, 6, 'six Originals require Pro');
// Nightshelf content/classics/release-holds.json: 128 playable, 35 free, 93 Pro.
assert.equal(Object.keys(catalog).length, 128, 'every playable listen has a shared route');
assert.equal(Object.values(catalog).filter(book => book.freeTier).length, 35);
for (const [id, title, freeTier] of [
  ['original_evening_they_kept', 'The Evening They Kept', true],
  ['original_borrowed_light', 'The Sea of Borrowed Light', false],
  ['original_tide_glass_observatory', 'The Tide-Glass Observatory', true],
  ['original_garden_between_stations', 'The Garden Between Stations', false],
  ['original_space_between_replies', 'The Space Between Replies', true],
]) {
  assert.equal(catalog[id]?.title, title, id + ' must name the intended story');
  assert.equal(catalog[id]?.freeTier, freeTier, id + ' must preserve its intended access');
  assert.equal(catalog[id]?.kind, 'original', id + ' must use the AI-disclosing Original card');
}
// Classics added in 1.8 and 1.9.
for (const [id, free] of [
  ['canterville_ghost', true], ['brick_moon', true], ['cousin_phillis', false], ['great_stone_sardis', false],
  ['frankenstein', true], ['journey_earth', true], ['tales_shakespeare', true], ['meditations', true],
  ['huckleberry_finn', false], ['prince_pauper', false], ['little_men', false], ['marvelous_land_oz', false],
  ['white_fang', false], ['enchiridion', false], ['apology', false], ['odyssey', false],
]) {
  assert.equal(catalog[id]?.freeTier, free, id + ' access follows the app');
  assert.ok(!catalog[id].kind, id + ' is a full book');
}
// The 1.9 Familiar Tales inherit access from, and credit, their source collection.
for (const [id, free, collection] of [
  ['cinderella', false, 'Tales of Mother Goose'], ['snow_white', true, "Grimm's Fairy Tales"],
  ['sleeping_beauty', true, "Grimm's Fairy Tales"], ['beauty_beast', false, 'The Blue Fairy Book'],
  ['red_riding_hood', true, "Grimm's Fairy Tales"], ['rapunzel', true, "Grimm's Fairy Tales"],
  ['hansel_gretel', true, "Grimm's Fairy Tales"], ['jack_beanstalk', false, 'English Fairy Tales'],
  ['three_pigs', false, 'English Fairy Tales'], ['rip_van_winkle', false, 'The Sketch-Book'],
  ['sleepy_hollow', false, 'The Sketch-Book'], ['tell_tale_heart', false, 'Tales of Mystery & Imagination'],
]) {
  const book = catalog['bedtime_' + id];
  assert.equal(book?.freeTier, free, id + ' inherits source access');
  assert.equal(book.kind, 'selection');
  assert.equal(book.collection, collection);
}
// "Complete tale", as the app's share text says: Sleepy Hollow runs past an hour.
for (const book of selections) assert.ok(book.blurb.startsWith('A complete tale from ' + book.collection + '. '), book.title);
const freeCount = books.filter(book => book.freeTier).length;
assert.match(html, new RegExp('>' + books.length + '<'));
assert.match(html, new RegExp('>' + freeCount + '<'));
const freeSpines = html.match(/class="spines free" d="([^"]+)"/)[1].match(/M/g).length;
const proSpines = html.match(/class="spines pro" d="([^"]+)"/)[1].match(/M/g).length;
assert.equal(freeSpines, freeCount);
assert.equal(proSpines, books.length - freeCount);
for (const name of ['index.html', 'support.html', 'terms.html', 'privacy.html']) {
  const page = fs.readFileSync(path.join(root, name), 'utf8');
  assert.doesNotMatch(page, /\b(?:82(?: complete)? (?:books|classics|works)|eighty-two|eighty|fourteen(?: of| free)|sixty-six|sixty-nine)\b/i,
    name + ' must not advertise the retired catalog counts');
  for (const image of page.matchAll(/nightshelf\/og-image\.png\?v=([^"\s]+)/g)) {
    assert.equal(image[1], '20260922', name + ' must show the current catalog OG card');
  }
}
console.log(`PASS: ${books.length} shared books + ${selections.length} tales + ${originals.length} Originals, ${rejected.length} rejected queries, catalog counts and shelf artwork`);
