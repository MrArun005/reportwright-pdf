// A signer for pdf.sign from a PKCS#12 file (.p12 / .pfx: a key and its certificates under a password), through
// cmsSigner and node-forge (npm i node-forge; it is not a dependency of @reportwright/pdf). RSA keys, PKCS#1 v1.5.
//
//   import { p12Signer } from '@reportwright/pdf/examples/p12-signer.mjs';
//   await pdf.sign({ name: 'Signature1' }, { signer: p12Signer(fs.readFileSync('id.p12'), 'password') });
import forge from 'node-forge';
import { cmsSigner } from '@reportwright/pdf';

/** @param {Uint8Array} p12 the file's bytes @param {string} password */
export function p12Signer(p12, password) {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(p12).toString('binary')));
  const box = forge.pkcs12.pkcs12FromAsn1(asn1, password); // a wrong password throws here
  const bags = (type) => box.getBags({ bagType: type })[type] ?? [];
  const key = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)][0]?.key;
  if (!key) throw new TypeError('p12Signer: no private key in the file');
  const certs = bags(forge.pki.oids.certBag).map((b) => b.cert);
  // the signer's certificate first: the one whose public key is the key's
  const mine = certs.findIndex((c) => c.publicKey.n?.equals(key.n));
  if (mine < 0) throw new TypeError("p12Signer: no certificate for the file's key");
  certs.unshift(...certs.splice(mine, 1));
  return cmsSigner({
    certs: certs.map((c) => forge.pki.certificateToPem(c)).join('\n'),
    keyAlgorithm: 'rsa',
    sign(bytes, hash) {
      const md = { 'SHA-256': forge.md.sha256, 'SHA-384': forge.md.sha384, 'SHA-512': forge.md.sha512 }[hash].create();
      md.update(Buffer.from(bytes).toString('binary'));
      return Uint8Array.from(Buffer.from(key.sign(md), 'binary'));
    },
  });
}
