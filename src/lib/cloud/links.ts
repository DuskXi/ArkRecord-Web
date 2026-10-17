/** 审计链接：指向线上部署的那个 commit（本地开发时指向 master），点开看到的就是正在运行的代码 */
export const REPO_URL = 'https://github.com/DuskXi/ArkRecord-Web'
export const BUILD_COMMIT = __BUILD_COMMIT__
const REF = BUILD_COMMIT && BUILD_COMMIT !== 'dev' ? BUILD_COMMIT : 'master'

export const SECURITY_URL = `${REPO_URL}/blob/${REF}/SECURITY.md`
export const HG_VERIFY_URL = `${REPO_URL}/blob/${REF}/worker/hg-verify.ts`
export const DESIGN_URL = `${REPO_URL}/blob/${REF}/docs/rewrite/cloud-sync.md`
