// Prepared metadata for Nightshelf 1.9.17 build 84; availability is version-qualified.
(function () {
  'use strict';
  var additions = {
  "history_malleson_akbar": {
    "author": "G. B. Malleson",
    "blurb": "Malleson follows the Mughal dynasty from Babur and Humayun to Akbar, examining conquest, government, religious debate, and the emperor’s final years.",
    "coverAsset": "Covers/history_malleson_akbar",
    "freeTier": false,
    "minimumVersion": "1.9.17 build 84",
    "title": "Akbar"
  },
  "history_matheson_nightingale": {
    "author": "Annie Matheson",
    "availabilityNote": "This edition is available in the U.S. App Store region.",
    "blurb": "Matheson traces Florence Nightingale’s education, Crimean War nursing, and long campaigns to improve nursing and public health, drawing on letters and contemporary accounts.",
    "coverAsset": "Covers/history_matheson_nightingale",
    "freeTier": false,
    "minimumVersion": "1.9.17 build 84",
    "title": "Florence Nightingale: A Biography"
  },
  "history_muir_boyhood_youth": {
    "author": "John Muir",
    "blurb": "Muir remembers childhood by the Scottish coast, his family’s Wisconsin farm, homemade inventions, and the education that led him toward a life in the wild.",
    "coverAsset": "Covers/history_muir_boyhood_youth",
    "freeTier": true,
    "minimumVersion": "1.9.17 build 84",
    "title": "The Story of My Boyhood and Youth"
  }
};
  var base = window.nightshelfSharedBooks;
  var versioned = window.nightshelfVersionedSharedBooks;
  if (!base || !versioned) throw new Error('Existing shared catalogs must load before the Biography-three catalog.');
  var merged = Object.assign({}, base, versioned);
  if (Object.keys(merged).length !== 563) throw new Error('Expected reviewed 563 predecessor records; regenerate this prepared successor.');
  Object.keys(additions).forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(base, id) || Object.prototype.hasOwnProperty.call(versioned, id)) {
      throw new Error('Shared catalog has changed; regenerate the Biography-three catalog.');
    }
  });
  Object.keys(additions).forEach(function (id) { versioned[id] = additions[id]; });
}());
