// Prepared metadata for Nightshelf 1.9.17 build 84; availability is version-qualified.
(function () {
  'use strict';
  var additions = {
  "history_dubois_negro": {
    "author": "W. E. B. Du Bois",
    "availabilityNote": "This edition is available in the U.S. App Store region.",
    "blurb": "Du Bois surveys African history, the Atlantic slave trade, and Black life across the world in a 1915 work challenging the racial assumptions of its time.",
    "coverAsset": "Covers/history_dubois_negro",
    "freeTier": false,
    "minimumVersion": "1.9.17 build 84",
    "title": "The Negro"
  },
  "history_edwards_wales": {
    "author": "Owen M. Edwards",
    "blurb": "Edwards traces Welsh life through its landscape, princes, castles, poetry, religion, and industrial change, ending with the Wales of his own time.",
    "coverAsset": "Covers/history_edwards_wales",
    "freeTier": true,
    "minimumVersion": "1.9.17 build 84",
    "title": "A Short History of Wales"
  },
  "history_faxian_buddhistic_kingdoms": {
    "author": "Faxian",
    "blurb": "A Buddhist pilgrim journeys from China through Central Asia to India and Sri Lanka, recording sacred places, monastic life, and his hazardous return by sea.",
    "coverAsset": "Covers/history_faxian_buddhistic_kingdoms",
    "freeTier": true,
    "minimumVersion": "1.9.17 build 84",
    "title": "A Record of Buddhistic Kingdoms"
  },
  "history_pennell_ancient_rome": {
    "author": "Robert F. Pennell",
    "blurb": "A nineteenth-century school history follows Rome from its early legends and republican struggles to imperial power, with a closing chronology.",
    "coverAsset": "Covers/history_pennell_ancient_rome",
    "freeTier": false,
    "minimumVersion": "1.9.17 build 84",
    "title": "Ancient Rome"
  },
  "history_sarmiento_incas": {
    "author": "Pedro Sarmiento de Gamboa",
    "blurb": "Sarmiento’s 1572 account of Inca rulers and traditions appears in Markham’s English translation, with the translator’s introduction and the original verification certificate.",
    "coverAsset": "Covers/history_sarmiento_incas",
    "freeTier": false,
    "minimumVersion": "1.9.17 build 84",
    "title": "History of the Incas"
  }
};
  var base = window.nightshelfSharedBooks;
  var versioned = window.nightshelfVersionedSharedBooks;
  if (!base || !versioned) throw new Error('Existing shared catalogs must load before the History-five catalog.');
  var merged = Object.assign({}, base, versioned);
  if (Object.keys(merged).length !== 558) throw new Error('Expected reviewed 558 predecessor records; regenerate this prepared successor.');
  Object.keys(additions).forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(base, id) || Object.prototype.hasOwnProperty.call(versioned, id)) {
      throw new Error('Shared catalog has changed; regenerate the History-five catalog.');
    }
  });
  Object.keys(additions).forEach(function (id) { versioned[id] = additions[id]; });
}());
