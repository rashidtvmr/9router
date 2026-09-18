// Default relay proxy pools, seeded into a fresh DB on first boot.
// Source of truth lives here — edit this file to add/update relay URLs, no
// separate script run needed. Seeding is idempotent (INSERT OR REPLACE by
// stable id) and never touches user-modified pools (matched by proxyUrl).
// Row shape matches proxyPoolsRepo.createProxyPool: name, proxyUrl, type.
// NOTE: type "cloudflare" is the relay discriminator used by
// OPENCODE_FREE_SESSION_ROTATION (vercel/cloudflare/deno); these AWS
// lambda-url relays are fronted by edge workers, so they carry "cloudflare".

export const DEFAULT_RELAY_POOLS = [
  {
    name: "cloudflare-relay-via-router",
    proxyUrl: "https://cloudflare-relay-via-router.ezcommify.workers.dev",
    type: "cloudflare",
  },
  {
    name: "aws-relay-us-east-1",
    proxyUrl: "https://73ycczrhgtlloarfy7eoewnrem0upmbt.lambda-url.us-east-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-us-east-2",
    proxyUrl: "https://kggf7cm4rxdpnnbnyjpubl76zy0gzsby.lambda-url.us-east-2.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-us-west-1",
    proxyUrl: "https://tcpomdgtrevccx75pri5hs3cuq0wwpih.lambda-url.us-west-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-us-west-2",
    proxyUrl: "https://sh367d2imdc7deu4gvij3miopa0hqayp.lambda-url.us-west-2.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-ca-central-1",
    proxyUrl: "https://kzu4s5pg3s37cau35d2wwcwq6i0flyie.lambda-url.ca-central-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-sa-east-1",
    proxyUrl: "https://6ss3eyuqn7ijhvasddiouubega0pvvov.lambda-url.sa-east-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-eu-west-1",
    proxyUrl: "https://elfchvs2k2vfj3nyxpfg7ypuea0gqukp.lambda-url.eu-west-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-eu-west-2",
    proxyUrl: "https://kbmbl3ugfyf2pty47wdi4xnp2y0rfcme.lambda-url.eu-west-2.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-eu-west-3",
    proxyUrl: "https://4dmhydmdeutwhrlcwltsbcdnwm0xoros.lambda-url.eu-west-3.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-eu-central-1",
    proxyUrl: "https://i6nlphgtx7vqmsuwsqnbtrbmqu0xmswm.lambda-url.eu-central-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-eu-north-1",
    proxyUrl: "https://kifrwk2qpuyj7fnhafpnella3q0nzgqm.lambda-url.eu-north-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-ap-south-1",
    proxyUrl: "https://unhbbbzarjcld3fjf472dzsgjy0nushh.lambda-url.ap-south-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-ap-southeast-1",
    proxyUrl: "https://bcscvebmzkdkbvjvkqkfj7g6sq0rutdh.lambda-url.ap-southeast-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-ap-southeast-2",
    proxyUrl: "https://ahtkkij52qpizvspk7bvt6owne0mqtqd.lambda-url.ap-southeast-2.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-ap-northeast-1",
    proxyUrl: "https://i2l7mk74cu7qa2m5jvfz4aiaye0uosun.lambda-url.ap-northeast-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-ap-northeast-2",
    proxyUrl: "https://zihehckt4zcuaqvjz6scjr53qi0etxxo.lambda-url.ap-northeast-2.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws-relay-ap-northeast-3",
    proxyUrl: "https://fdcdnaeuvbmcmbrzwqay33mwqq0lvaqp.lambda-url.ap-northeast-3.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-us-west-2",
    proxyUrl: "https://2aggiayr5awhnyguw4oe4yxzuu0jhyiz.lambda-url.us-west-2.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-us-east-1",
    proxyUrl: "https://32oypghcxlfd5ze2ybihm7toka0iptbz.lambda-url.us-east-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-ap-northeast-1",
    proxyUrl: "https://3mtwgnny4kvnos5vlc6j2a37y40vfdod.lambda-url.ap-northeast-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-eu-west-3",
    proxyUrl: "https://5vekwwpemmx5b6hpjicyffhmli0ahmro.lambda-url.eu-west-3.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-sa-east-1",
    proxyUrl: "https://6p7lvrbedpp23ian4mb7luf2xq0ndvpe.lambda-url.sa-east-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-eu-central-1",
    proxyUrl: "https://7ctkf27oudrjmud73ek3bna5oa0lqgwj.lambda-url.eu-central-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-ap-southeast-2",
    proxyUrl: "https://almlmfesqu5fgeowv5jl27kuy40xgadq.lambda-url.ap-southeast-2.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-us-west-1",
    proxyUrl: "https://c5uk4dlkkytkkob5pgbtblwnqy0qviue.lambda-url.us-west-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-eu-north-1",
    proxyUrl: "https://e63ltnmvootkzy7vfxsfsn7spq0qtwqr.lambda-url.eu-north-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-us-east-2",
    proxyUrl: "https://h7awctsz544g7mbh2azppbs6ka0vvgdu.lambda-url.us-east-2.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-ap-southeast-1",
    proxyUrl: "https://iw2yi3ezg4paw2ujrdz4q46ssi0xibwa.lambda-url.ap-southeast-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-eu-west-1",
    proxyUrl: "https://jpryz5vyndnk2zis2dxza4r3p40gqpyn.lambda-url.eu-west-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-ap-northeast-2",
    proxyUrl: "https://lj4bg6d3ufg6pqevrfr5tnzrjq0lhgzc.lambda-url.ap-northeast-2.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-ap-south-1",
    proxyUrl: "https://mbishlq4stdlqrtoflar25ee2m0idwhu.lambda-url.ap-south-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-ap-northeast-3",
    proxyUrl: "https://nj7gj4pmnnisgtbnxwtfvllaii0tiach.lambda-url.ap-northeast-3.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-ca-central-1",
    proxyUrl: "https://qi24iirizssqe4kewgumk6f6bq0vqwjg.lambda-url.ca-central-1.on.aws/",
    type: "cloudflare",
  },
  {
    name: "aws2-relay-eu-west-2",
    proxyUrl: "https://tlk5tjcyhlmgbvp7melgd7lowe0tcizv.lambda-url.eu-west-2.on.aws/",
    type: "cloudflare",
  },
];
