// Canned Docker Hub responses for each scenario in run.sh.
//
// One file per request, named <METHOD>_<url with every non-alphanumeric
// character replaced by _>, matching the lookup in stubs/curl. The first line
// is the HTTP status, the rest is the body. A request with no fixture is a 404,
// which is how "this tag does not exist yet" is expressed.

import fs from 'fs';
import path from 'path';

const [outputDir] = process.argv.slice(2);
if (!outputDir) {
  console.error('usage: make-fixtures.mjs <output-dir>');
  process.exit(1);
}

const API = 'https://hub.docker.com/v2';
const REPO = `${API}/repositories/i7gamer/tutto`;
const PAGE_ONE = `${REPO}/tags?page_size=100`;
const PAGE_TWO = `${REPO}/tags?page=2&page_size=100`;
const PAGE_THREE = `${REPO}/tags?page=3&page_size=100`;

const slug = url => url.replace(/[^A-Za-z0-9]/g, '_');

const write = (scenario, method, url, status, body) => {
  const dir = path.join(outputDir, scenario);
  fs.mkdirSync(dir, { recursive: true });
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  fs.writeFileSync(path.join(dir, `${method}_${slug(url)}.txt`), `${status}\n${payload}`);
};

const loginOk = scenario => write(scenario, 'POST', `${API}/users/login`, 200, { token: 'jwt-for-tests' });
const tag = (scenario, name, status, body) => write(scenario, 'GET', `${REPO}/tags/${name}`, status, body ?? {});
const tagList = (scenario, url, body) => write(scenario, 'GET', url, 200, body);
const deleteManifest = (scenario, digest, status, body) =>
  write(scenario, 'DELETE', `${REPO}/manifests/${digest}`, status, body ?? '');

const TAG_NOT_FOUND = { message: 'tag not found' };

// Written in place of a status to make the curl stub fail the way a connection
// failure does: nothing on stdout, non-zero exit, no HTTP status at all. Kept
// in sync with the check in stubs/curl.
const TRANSPORT_ERROR = 'transport-error';

// 1. Nothing has been published under this tag yet.
loginOk('first-publish');
tag('first-publish', 'nightly', 404, TAG_NOT_FOUND);

// 2. A republish where one arch sub-manifest is unchanged, so the new index
//    reuses it. It must survive even though the superseded index referenced it.
loginOk('shared-submanifest');
tag('shared-submanifest', 'latest', 200, {
  digest: 'sha256:old0',
  images: [{ digest: 'sha256:old1' }, { digest: 'sha256:aaa' }],
});
tag('shared-submanifest', '1.1.3', 404, TAG_NOT_FOUND);
tagList('shared-submanifest', PAGE_ONE, {
  next: null,
  results: [{ digest: 'sha256:new0', images: [{ digest: 'sha256:aaa' }, { digest: 'sha256:new1' }] }],
});
deleteManifest('shared-submanifest', 'sha256:old0', 202);
deleteManifest('shared-submanifest', 'sha256:old1', 202);

// 3. Hub rejects the delete. The failure has to surface, not be counted as done
//    — the original code reported every status as a successful deletion.
loginOk('delete-refused');
tag('delete-refused', 'latest', 200, { digest: 'sha256:old0', images: [] });
tagList('delete-refused', PAGE_ONE, { next: null, results: [{ digest: 'sha256:new0', images: [] }] });
deleteManifest('delete-refused', 'sha256:old0', 405, { message: 'method not allowed' });

// 4. A still-referenced digest that only appears on page two of the tag
//    listing. Without pagination the keep-set misses it and it gets deleted.
loginOk('paginated');
tag('paginated', 'latest', 200, {
  digest: 'sha256:old0',
  images: [{ digest: 'sha256:old1' }, { digest: 'sha256:page2' }],
});
tagList('paginated', PAGE_ONE, { next: PAGE_TWO, results: [{ digest: 'sha256:new0', images: [] }] });
tagList('paginated', PAGE_TWO, { next: null, results: [{ digest: 'sha256:page2', images: [] }] });
deleteManifest('paginated', 'sha256:old0', 202);
deleteManifest('paginated', 'sha256:old1', 202);

// 5. A 200 that lists no tags at all. Deleting against that keep-set would
//    empty the repository.
loginOk('empty-keepset');
tag('empty-keepset', 'latest', 200, { digest: 'sha256:old0', images: [] });
tagList('empty-keepset', PAGE_ONE, { next: null, results: [] });
deleteManifest('empty-keepset', 'sha256:old0', 202);

// 6. Credentials rejected. A publish must not fail because cleanup cannot log in.
write('login-fails', 'POST', `${API}/users/login`, 401, { detail: 'incorrect authentication credentials' });
tag('login-fails', 'latest', 200, { digest: 'sha256:old0', images: [] });

// 7. A login that succeeds without handing out a token — what Hub answers when
//    the account has 2FA enabled. `jq -r '.token'` prints the string "null" and
//    curl exits 0, so a guard that only checks curl's status sends
//    `Authorization: JWT null` at every later call and reports "nothing to
//    supersede" forever. The tag, listing and delete fixtures below all exist so
//    that a missing guard visibly proceeds instead of failing to find them.
write('login-no-token', 'POST', `${API}/users/login`, 200, { login_2fa_token: 'second-factor-required' });
tag('login-no-token', 'latest', 200, { digest: 'sha256:old0', images: [] });
tagList('login-no-token', PAGE_ONE, { next: null, results: [{ digest: 'sha256:new0', images: [] }] });
deleteManifest('login-no-token', 'sha256:old0', 202);

// 8. The tag listing fails mid-way. The keep-set is incomplete, so deleting
//    against it would remove a live manifest.
loginOk('tag-list-fails');
tag('tag-list-fails', 'latest', 200, { digest: 'sha256:old0', images: [] });
write('tag-list-fails', 'GET', PAGE_ONE, 500, { message: 'internal server error' });
deleteManifest('tag-list-fails', 'sha256:old0', 202);

// 9. A listing that never stops paginating. Bounded by MAX_TAG_PAGES, which
//    run.sh lowers for this scenario; page three is never requested.
loginOk('too-many-pages');
tag('too-many-pages', 'latest', 200, { digest: 'sha256:old0', images: [] });
tagList('too-many-pages', PAGE_ONE, { next: PAGE_TWO, results: [{ digest: 'sha256:new0', images: [] }] });
tagList('too-many-pages', PAGE_TWO, { next: PAGE_THREE, results: [{ digest: 'sha256:new1', images: [] }] });
deleteManifest('too-many-pages', 'sha256:old0', 202);

// 10. One delete never reaches the API. `-w '%{http_code}'` yields no status,
//     so an unguarded command substitution under `set -e` kills the step: the
//     remaining digests are never attempted and the summary never prints, all
//     swallowed by continue-on-error.
loginOk('delete-transport-error');
tag('delete-transport-error', 'latest', 200, {
  digest: 'sha256:old0',
  images: [{ digest: 'sha256:old1' }],
});
tagList('delete-transport-error', PAGE_ONE, { next: null, results: [{ digest: 'sha256:new0', images: [] }] });
deleteManifest('delete-transport-error', 'sha256:old0', TRANSPORT_ERROR);
deleteManifest('delete-transport-error', 'sha256:old1', 202);
