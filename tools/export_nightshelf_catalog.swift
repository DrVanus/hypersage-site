// Compile with the app's SleepCatalog.swift, then redirect stdout to
// nightshelf/shared-book-catalog.js. Uses the shipping catalog verbatim.
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
        let data = try JSONSerialization.data(withJSONObject: catalog, options: [.prettyPrinted, .sortedKeys])
        print("// Generated from Nightshelf SleepCatalog.swift. See tools/export_nightshelf_catalog.swift.")
        print("window.nightshelfSharedBooks = " + String(decoding: data, as: UTF8.self) + ";")
    }
}
