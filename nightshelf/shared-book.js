/* Only a deliberate tap opens the app. Unknown/private ids keep the welcome page. */
(function () {
  'use strict';
  var ids = new URLSearchParams(window.location.search).getAll('book');
  if (ids.length !== 1) return;
  var id = ids[0];
  var catalog = window.nightshelfSharedBooks;
  var versioned = false;
  if (!catalog || !Object.prototype.hasOwnProperty.call(catalog, id)) {
    catalog = window.nightshelfVersionedSharedBooks;
    if (!catalog || !Object.prototype.hasOwnProperty.call(catalog, id)) return;
    versioned = true;
  }
  var book = catalog[id];
  var card = document.getElementById('shared-book');
  if (!card) return;

  // The query selects an allowlisted record; it never becomes HTML or a URL.
  // An Original is AI-written: the card says so in the same words as the app.
  var original = book.kind === 'original';
  document.getElementById('shared-book-title').textContent = book.title;
  document.getElementById('shared-book-author').textContent = original ? 'A Nightshelf Original' : 'by ' + book.author;
  document.getElementById('shared-book-description').textContent = original
    ? book.blurb + ' ' + book.disclosure
    : book.blurb;
  var access = book.freeTier ? 'Free on Nightshelf' : 'Included with Nightshelf Pro';
  document.getElementById('shared-book-edition').textContent = versioned
    ? 'Requires Nightshelf ' + book.minimumVersion + ' or later. ' + access
    : access;
  if (versioned) {
    document.getElementById('shared-book-help').textContent =
      'Already have Nightshelf ' + book.minimumVersion + ' or later? Open this story on your iPhone. ' +
      'Otherwise, keep this link and update when that version becomes available.';
  }
  document.getElementById('shared-book-open').href = 'nightshelf://book/' + encodeURIComponent(id);
  document.title = original
    ? book.title + ' — a Nightshelf Original'
    : book.title + ' by ' + book.author + ' — Nightshelf';
  card.hidden = false;
})();
