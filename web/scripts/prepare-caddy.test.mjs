import test from "node:test";
import assert from "node:assert/strict";
import { prepareHtml, policy } from "./prepare-caddy.mjs";

test("every exported bootstrap script gets the same response-local nonce", () => {
  const input = '<!DOCTYPE html><html><head><link rel="preload" as="script" href="/_next/static/a.js"><script src="/_next/static/a.js" async></script></head>' +
    '<body><p>{{env "PRIVATE_VALUE"}}</p><script>self.__next_f.push([1,"hello"])</script></body></html>';
  const output = prepareHtml(input);
  assert.equal((output.match(/nonce="\[\[DM_CSP \$nonce DM_CSP\]\]"/g) ?? []).length, 3);
  assert.equal((output.match(/randAlphaNum 32/g) ?? []).length, 1);
  assert.ok(output.includes('{{env "PRIVATE_VALUE"}}'), "ordinary content remains literal");
  assert.ok(output.includes('"Cache-Control" "no-store"'));
  assert.match(policy, /script-src 'nonce-%s' 'strict-dynamic'; script-src-attr 'none'/);
  assert.doesNotMatch(policy.split("script-src ")[1].split(";")[0], /unsafe-inline|unsafe-eval|https:|'self'/);
});

test("template collisions and pre-existing nonces stop the build", () => {
  for (const input of ["<html>no export</html>", '<!DOCTYPE html><script nonce="fixed">x</script>',
    '<!DOCTYPE html><script>x</script>[[DM_CSP env "SECRET" DM_CSP]]']) {
    assert.throws(() => prepareHtml(input));
  }
});
