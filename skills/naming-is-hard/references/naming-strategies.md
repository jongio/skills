# Naming strategies

The engine learns taste; you supply the creativity. A great deck spans many of
these strategies so the user has real range to react to. Aim for variety across
length, sound, and style, not twenty variations of one idea. Tag each candidate
with its `strategy` when you `add` it, so the model can learn which strategies the
user gravitates to.

## The strategies

| Strategy | Idea | Examples |
|---|---|---|
| Descriptive | Say what it does, plainly. | Dropbox, Photobucket, Salesforce |
| Compound | Glue two real words. | Facebook, Firefox, Brightloom |
| Portmanteau | Blend two words into one. | Pinterest (pin + interest), Instagram, Groupon |
| Coined | Invent a word that sounds right. | Kodak, Xerox, Zynga, Hulu |
| Vowel-dropped | Drop a vowel for a techy feel. | Flickr, Tumblr, Grindr |
| Real word | Repurpose a dictionary word. | Apple, Amazon, Slack, Ghost |
| Metaphor / evocative | Borrow an image or feeling. | Amazon (vast), Nike (victory), Oracle |
| Classical roots | Latin or Greek stems. | Verdant, Lumen, Nova, Aegis, Sonos |
| Foreign word | A fitting word from another language. | Volvo ("I roll"), Samsung, Audi |
| Suffix play | A stem plus a modern suffix. | Spotify (-ify), Feedly (-ly), Twilio (-io) |
| Prefix play | A modern prefix plus a stem. | GetHarvest, GoCardless, Notion |
| Alliteration | Repeat the initial sound. | Coca-Cola, PayPal, TikTok, Krispy Kreme |
| Reduplication | Repeat or rhyme a syllable. | Zynga, Jaja, Kiwi, Bonbon |
| Abstract / short | A short, meaning-light mark. | Etsy, Elo, Vox, Rune |
| Acronym / initialism | Letters that expand to a phrase. | IKEA, IBM, HBO |
| Mythology / lore | Gods, creatures, legends. | Nike, Pandora, Hermes, Kraken |
| Nature | Plants, animals, elements. | Verdant, Willow, Ember, Otter |
| Founder / place | A person or a place. | Tesla, Amazon (river), Adobe (creek) |

## Tips for a good deck

- Cover the extremes on each axis: a couple of very short names and a couple of
  longer ones; some hard/techy sounds and some soft/warm ones; some coined and some
  real. The model needs contrast early to learn fast.
- Make the pitch specific. "A warm, growing-light name for a calm productivity app"
  beats "a nice name". The pitch is the card's personality.
- Respect the brief's constraints (length, one-word, `.com`-able) but do not let
  them flatten variety; break a constraint occasionally as a wildcard and let the
  user tell you it matters.
- When refilling the deck after the model has a type, generate mostly in that
  direction but keep a few wildcards so the user keeps discovering. `suggest --name`
  gives quick morphological variants of a name they already liked.
- Read a name out loud before adding it. If it is hard to say or spell, cut it.
