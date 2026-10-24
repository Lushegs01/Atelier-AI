# Reference and design decisions

Primary reference: [AI Fashion App — Outfit & Style Exploration by UIX Habib](https://dribbble.com/shots/27634034-AI-Fashion-App-Outfit-Style-Exploration). The page and actual shot were inspected in a browser on 24 October 2026. The shot shows three rounded mobile screens on a light grey canvas: a white discovery list, an immersive cool-blue garment viewer with chips and circular controls, and a large portrait above sparse photo/try-on mode controls. The shot’s design is a reference, not copied product artwork.

Atelier AI translates those features into a desktop sidebar, compact mobile bottom navigation, private garment cards, scene selectors and a dominant source-image canvas. The supplied navy/blue-grey palette is implemented as CSS variables and Tailwind tokens. White surfaces and restrained borders carry most of the layout. Arial/system sans-serif handles controls; Georgia gives selected headlines an editorial accent without external font loading.

Original garment selection is separate from model, pose and setting. Balanced 1K is the only initially priced photo mode. There are no colour controls that silently redesign the piece. Quotes are confirmed before charging. A new workspace displays empty states, not invented customer activity.

Shared controls include keyboard-accessible Radix dialogs/tooltips, buttons, fields, chips, selects, upload zones, badges, notices, toasts, progress, empty states and skeletons. Focus outlines, reduced-motion CSS, mobile bottom sheets and touch navigation are provided. Browser checks are recorded separately; this is not a claim of WCAG certification.

## Illustrative imagery

Public editorial images are served from Unsplash and clearly labeled as stock photography, not AI generation results:

- `photo-1539109136881-3be0616acf4b`: street fashion hero
- `photo-1532453288672-3a27e9be9efd`: fashion detail
- `photo-1524504388940-b1c1722653e1`: portrait
- `photo-1483985988355-763728e1935b`: collection inspiration

Only these public images use the public image optimizer. Private garments and customer photographs are served via authorized private URLs. Review the current [Unsplash license](https://unsplash.com/license), image identity and any additional commercial publicity/property considerations before launch; replace with owned campaign assets where appropriate.
