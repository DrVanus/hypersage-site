// Compile with the app's SleepCatalog.swift, OriginalStories.swift,
// BedtimeSelections.swift (and what they need), then redirect stdout to
// nightshelf/shared-book-catalog.js. Uses the shipping catalog verbatim.
// Classics carry no "kind"; selected tales and AI-written Originals do, so the
// page can name them honestly and the shelf counts stay the classics.
import Foundation

@main struct ExportNightshelfCatalog {
    static func main() throws {
        var catalog: [String: [String: Any]] = [:]
        for book in SleepCatalog.books {
            precondition(catalog[book.id] == nil, "Duplicate book id")
            catalog[book.id] = [
                "title": book.title, "author": book.author,
                "blurb": book.blurb, "freeTier": book.freeTier,
            ]
        }
        for tale in BedtimeSelections.all {
            guard let source = tale.sourceBook else { preconditionFailure("selection without a source book") }
            precondition(catalog[tale.id] == nil, "Duplicate selection id")
            catalog[tale.id] = [
                "title": tale.title, "author": source.author,
                "blurb": "A complete tale from " + source.title + ". " + tale.contentNote,
                "freeTier": source.freeTier, "kind": "selection", "collection": source.title,
            ]
        }
        for story in OriginalStories.all {
            precondition(catalog[story.id] == nil, "Duplicate original id")
            catalog[story.id] = [
                "title": story.title, "author": "Nightshelf",
                "blurb": story.blurb, "freeTier": story.freeTier,
                "kind": "original", "disclosure": OriginalStories.disclosure,
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: catalog, options: [.prettyPrinted, .sortedKeys])
        print("// Generated from Nightshelf SleepCatalog, BedtimeSelections and OriginalStories. See tools/export_nightshelf_catalog.swift.")
        print("window.nightshelfSharedBooks = " + String(decoding: data, as: UTF8.self) + ";")
    }
}
