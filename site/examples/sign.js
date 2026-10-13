// PAdES B-B signing in the browser: WebCrypto signs, cmsSigner wraps the signature in a CMS. Then a
// countersignature is appended with saveIncremental, so the first signature stays valid.
// The key and self-signed certificate below are a PUBLIC TEST PAIR made for this demo: never trust them.
// In Node, nodeSigner({ key, certs }) does the same with node:crypto; an HSM or cloud KMS also fits cmsSigner.
import { toBytes, loadPdf, cmsSigner } from '@reportwright/pdf';

const KEY = ['-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCx5CZQ4DmvG7HG',
  'X+aXOhL3X6o31T10UvsDsrdkvEr3wxOE/3kodp+pqlXsk6XwsMBHJfXF2OohUBKw',
  'wW901w5Ue3qnypYIpYmMTmUr3a9wCwnJeDty4QKicUJJLBUWjI9l3Yta9dHapAY0',
  'SPQGKSxNBFoh4yFWdnbWdRvyiCBIfBlVJX2uUGvuQONrhpCBAkQYHlJlxio+GjNG',
  'SWz7BFSeIRuXdrAHJnIrYjgMlOQIOV56QsUKqrhAySPXuA6xQwlAmoalVigGv5Kz',
  'aeTTmkLoqlsZRmYUXX4amW7vY1OzXhlK5NQyLlNJaRsxTmTnKA1Q8k9syvuNX+fV',
  '67kgu76FAgMBAAECggEAMvrUxjm0Hkw8AsNKBI3GkLEQSYbpYTRErnchmpNhkqaL',
  'qgJC2QdB03A2xqE7nYIx4FHvIL98vYZCjPgqdlwJRcnLSVnD7H9wL07qLIuP8vae',
  '2+eCdfYo+J+npOumsXsfv0wh2zP2a4e1JXfAwyE6imnUYMDENZCmlugh1bwQMGUx',
  '1hSi54A5UJLnyJhfJ5GGF4zulPogCP7OcZ/M3MxnCuAmQuYINHrzt8SFgBQ7L7wo',
  'If4pEENGoeX4ogAQEFkHXzgjKPhXQz1d3OSD7+1YqvB38qzOrvGslL3fmxrBsDnG',
  'Gca9+e037TakcfYWVdgWQ4G+PLSwi00U/4YNgfh/UwKBgQDW588bqUup/R5api0L',
  'aKH92sgmyg1sD5XLjmIIZhIzWi5ykJS9u3KE/Vz3jsA5lvagd3ykH6OQpv6L1eYp',
  'BFoRvaOwrXeuN0NQbPYS1rsd6TDDgMOQwIqHb3/gZtl4x01MF5wQG40jQKgXrbfB',
  'GLn+LZnDceewl6N/kOOx0ik7gwKBgQDT6GSzrXtwttBn8SYi9raZvRZnxjYyftD2',
  'GJTK6vNDcKA2931mcMMIeoEioff6h0vj2ovpiCer6LQP71PbDT3qYBH2RxiPCe5R',
  'JHkxZs9yogzUZHB33e+3c5jqMQay+nd5pSQy6kfGI+liiYRpdJYCKtzsGIH+0Ejd',
  'Zr7cJVVXVwKBgAEP/FIisCETA0dncumPht1+a2blsNNL8G2lMo7gEk72rywZ0uJt',
  'Ps+xgPgoWILwYB/C93bIQULB0JhYYl7piphz249QDDtsQoTvRPgq35nyQS92P4FD',
  'smug/XzahVC3i4ZIx5i8yiHWe/5B+ZqWyLSc/RmeQor49PH4gWerplCJAoGAXvmQ',
  'cMt3QNxe6cc2PYNv8dXCvf4jelxGUZZQ0eWd5AMNe7VO2eP+NcWaLSiE2R9cjyH7',
  'hU6F4VGpql6sqcf0kSA/zK6uviVIT8vWGaMnpQwmTec6VS7+aq1/wq74fq0tcTLn',
  '134TbyXXS1exJgaf2RbW72ZIlSlLDxgmwMpmxn8CgYEArwXXVzAeTfrLv3cxBGgS',
  'CgP6Yd9IM0p3MOMK07iPmBnhwaxrGvEp/l54vSfs15V7AIZUZB4SnCQGzsmwnfey',
  'DbgVzxPVkAu4bKyggX6Ju6Bg7NgiElaIuWP+hKR+RReBQKQbTox9iodA2sJHYAXc',
  'm14B8deASrFCdef/3Zd45tA=',
  '-----END PRIVATE KEY-----'].join('\n');
const CERT = ['-----BEGIN CERTIFICATE-----',
  'MIIDHjCCAgagAwIBAgIUA1ELo3K9pK0CBaMzsABS3RzWHvgwDQYJKoZIhvcNAQEL',
  'BQAwLzEtMCsGA1UEAwwkUmVwb3J0V3JpZ2h0IGRlbW8gc2lnbmVyIChURVNUIE9O',
  'TFkpMB4XDTI2MTAxMzA1NTgyNVoXDTM2MTAxMDA1NTgyNVowLzEtMCsGA1UEAwwk',
  'UmVwb3J0V3JpZ2h0IGRlbW8gc2lnbmVyIChURVNUIE9OTFkpMIIBIjANBgkqhkiG',
  '9w0BAQEFAAOCAQ8AMIIBCgKCAQEAseQmUOA5rxuxxl/mlzoS91+qN9U9dFL7A7K3',
  'ZLxK98MThP95KHafqapV7JOl8LDARyX1xdjqIVASsMFvdNcOVHt6p8qWCKWJjE5l',
  'K92vcAsJyXg7cuEConFCSSwVFoyPZd2LWvXR2qQGNEj0BiksTQRaIeMhVnZ21nUb',
  '8oggSHwZVSV9rlBr7kDja4aQgQJEGB5SZcYqPhozRkls+wRUniEbl3awByZyK2I4',
  'DJTkCDleekLFCqq4QMkj17gOsUMJQJqGpVYoBr+Ss2nk05pC6KpbGUZmFF1+Gplu',
  '72NTs14ZSuTUMi5TSWkbMU5k5ygNUPJPbMr7jV/n1eu5ILu+hQIDAQABozIwMDAd',
  'BgNVHQ4EFgQU9Abiyorb5UreQhxchf/jR1zYZlcwDwYDVR0TAQH/BAUwAwEB/zAN',
  'BgkqhkiG9w0BAQsFAAOCAQEAQnQz2w5l5NYEug6kW8e6k2+8mJO7fLq6YQsV58/R',
  'u6e4w1gWQ+raLpYIVMwtH76CluRIPeQnnMVNYlsnUcWj5KaEf0S0ugJAZ6/5+Qeq',
  'Dm2xCxk8zZEGP07KXeBpjQw6kQYRYRxy1AZ8jP3WfI+b8BmkY82jwXuB+h7g+pPN',
  'r9lyu9BQe5lc73GRCGZq2EQ/Y61NbNG6T5FFa1Y6YpTyowQulzWaIlUfBqL1KHHj',
  'jwWj52TT7jZL6xr+IoD/KABgKcNqAM58HTUOSegmXlthd1fc7/tOo81bRKL5BSIh',
  '+4Z7EmogAGfx/fZoXprZNU2S9AXGK0exC1s8oCamAxelxA==',
  '-----END CERTIFICATE-----'].join('\n');

const der = Uint8Array.from(atob(KEY.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
const keys = {};                                                // one CryptoKey per hash
const signer = cmsSigner({
  certs: CERT,
  keyAlgorithm: 'rsa',
  async sign(data, hash) {                                      // hash: 'SHA-256' | 'SHA-384' | 'SHA-512'
    keys[hash] ??= await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys[hash], data));
  },
});

const signed = await toBytes(async (pdf) => {
  const font = pdf.standardFont('Helvetica');
  const page = pdf.addPage();
  page.text('Offer letter', { x: 40, y: 40, font, size: 18 });
  const hr = pdf.form.signature('hr', { page, x: 40, y: 700, width: 200, height: 40, tooltip: 'HR signature' });
  pdf.form.signature('candidate', { page, x: 300, y: 700, width: 200, height: 40, tooltip: 'Candidate signature' });
  await pdf.sign(hr, { signer, reason: 'Issued', location: 'Bengaluru', name: 'HR', certify: 2 });
  await page.end();
}, { title: 'Offer letter', sign: true });
show(signed, 'signed.pdf');

const { bytes } = await (await loadPdf(signed)).saveIncremental({ sign: { field: 'candidate', signer, reason: 'Accepted' } });
const sigs = (await loadPdf(bytes)).signatures;
log(sigs.map((s) => s.field + ': revision ' + s.revision + ', covers whole file: ' + s.coversWholeFile).join('\n'));
show(bytes, 'countersigned.pdf');
