/* Only a deliberate tap opens the app. Unknown/private ids keep the welcome page. */
(function () {
  'use strict';
  var ids = new URLSearchParams(window.location.search).getAll('book');
  if (ids.length !== 1) return;
  var id = ids[0];
  var catalog = window.nightshelfSharedBooks;
  if (!catalog || !Object.prototype.hasOwnProperty.call(catalog, id)) return;
  var book = catalog[id];
  var card = document.getElementById('shared-book');
  if (!card) return;

  // The query selects an allowlisted record; it never becomes HTML or a URL.
  document.getElementById('shared-book-title').textContent = book.title;
  document.getElementById('shared-book-author').textContent = 'by ' + book.author;
  document.getElementById('shared-book-description').textContent = book.blurb;
  document.getElementById('shared-book-edition').textContent = book.freeTier
    ? 'Free on Nightshelf'
    : 'Included with Nightshelf Pro';
  document.getElementById('shared-book-open').href = 'nightshelf://book/' + encodeURIComponent(id);
  document.title = book.title + ' by ' + book.author + ' — Nightshelf';
  card.hidden = false;
})();
