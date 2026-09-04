# reviewable-cache-rfc

A proposal for adding an offline cache to the Acme command line tool.

The cache should let users repeat read-only commands while disconnected. Writes
must continue to fail offline. Reviewers need to decide cache invalidation,
maximum age, storage location, and the security treatment of cached responses.
