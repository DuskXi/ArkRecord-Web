<template>

  <div class="q-gutter-xs">
    <q-btn color="primary" @click="onDialogClick" label="Token管理器"/>
    <q-badge color="primary" :label="current['info']['nickName']" v-if="Object.keys(current).length > 0 && enableInfoShow"/>
    <q-badge color="green" :label="'uid: '+ current['info']['uid']" v-if="Object.keys(current).length > 0 && enableInfoShow"/>
    <div class="text-caption row inline" v-if="Object.keys(current).length > 0 && summaryDataSet.hasOwnProperty(`O/${current['info']['uid']}`)">
      寻访: <span class="text-amber-9">{{ summaryDataSet[`O/${current['info']['uid']}`].pool }}</span> 条,
      源石: <span class="text-amber-9">{{ summaryDataSet[`O/${current['info']['uid']}`].stone }}</span> 条,
      充值: <span class="text-amber-9">{{ summaryDataSet[`O/${current['info']['uid']}`].recharge }}</span> 条
    </div>
    <q-toggle v-model="enableInfoShow" label="显示个人信息"/>
  </div>
  <q-dialog v-model="dialog" persistent>
    <q-card :style="$q.screen.gt.sm? 'width: 1000px; max-width: 70vw;':'width: 96vw;'">
      <q-card-section>
        <div class="text-h6">登录管理器</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div class="text-h6">首先，确保你的
          <a href="https://ak.hypergryph.com/user/home" target="_blank"> 网站官服
            <q-icon name="open_in_new"/>
          </a>
          /
          <a href="https://ak.hypergryph.com/user/bilibili/home" target="_blank"> 鹰角B服
            <q-icon name="open_in_new"/>
          </a>
          已经登录
        </div>
        <div class="text-h6">然后前往这个
          <a href="https://as.hypergryph.com/user/info/v1/token_by_cookie" target="_blank"> 官服
            <q-icon name="open_in_new"/>
          </a>
          /
          <a href="https://web-api.hypergryph.com/account/info/ak-b" target="_blank"> B服
            <q-icon name="open_in_new"/>
          </a>
          把全部的东西都复制到下面的文本框里
        </div>
        <q-input v-model="jsonData" label="粘贴在这里" filled lazy-rules :rules="[v=>this.checkTokenJson(v) || '结构不完整，请重新复制']" :loading="syncLoading"/>
        <!--                  <div v-if="Object.keys(officialTempInfo).length > 0 "> :rules="[v=>this.checkOfficialTokenJson(v) || '结构不完整，请重新复制']"  -->
        <!--                    <div v-if="officialTempInfo.status===0" class="text-h6">昵称: {{ officialTempInfo.data['nickName'] }}</div>-->
        <!--                    <div v-if="officialTempInfo.status===0" class="text-h6">uid: {{ officialTempInfo.data['uid'] }}</div>-->
        <!--                    <div v-if="officialTempInfo.status===3" class="text-h6">token 失效, 请重新登录</div>-->
        <!--                  </div>-->
        <q-btn color="primary" label="点击添加" @click="saveOfficialTokens" :disable="!checkOfficialTokenJson(jsonDataOfficial)||  officialTempInfo.status!==0" :key="officialButton"/>
        <div class="text-h5">当前官服数据: {{ officialToken.length > 0 ? '' : '无' }}</div>
        <div class="text-h6">请注意点击对应的账号以加载数据</div>
        <q-list bordered separator>
          <q-item clickable v-ripple v-for="(value,index) in userInfos" :key="index" :active="value.active" active-class="bg-teal-1">
            <q-item-section avatar>
              <q-icon :name=" value.active?'person' : 'person_off'"/>
            </q-item-section>
            <q-item-section @click="active(value)">
              <div class="row" @mouseenter="showSecret[value.info['uid']] = true" @mouseleave="showSecret[value.info['uid']] = false">
                <div class="col-md-6 col-12-sm text-subtitle1"><span class="text-red-9">昵称</span>: {{ value.info['nickName'] }}</div>
                <div class="col-md-6 col-12-sm text-subtitle1"><span class="text-blue-5">uid</span>: {{ value.info['uid'] }}</div>
                <div class="col-12 text-subtitle1" style="word-break:break-all"><span class="text-green-5">token</span>
                  : {{ showSecret[value.info['uid']] ? value.token : secretString(value.token) }}
                </div>
                <div class="col-12" v-if="summaryDataSet.hasOwnProperty(`${value.type==='official' ?'O':'B'}/${value.info['uid']}`)">
                  寻访: <span class="text-amber-7">{{ summaryDataSet[`${value.type === 'official' ? 'O' : 'B'}/${value.info['uid']}`].pool }}</span> 条,
                  源石: <span class="text-amber-7">{{ summaryDataSet[`${value.type === 'official' ? 'O' : 'B'}/${value.info['uid']}`].stone }}</span> 条,
                  充值: <span class="text-amber-7">{{ summaryDataSet[`${value.type === 'official' ? 'O' : 'B'}/${value.info['uid']}`].recharge }}</span> 条
                </div>
              </div>
            </q-item-section>
            <q-item-section side>{{ value.active ? '已激活' : '' }}</q-item-section>
          </q-item>
        </q-list>
        <div class="text-h6 text-red-8">请不要随意泄露你的Token，这是你的隐私，如果不慎泄露请前往官网清除所有设备登录</div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="OK" color="primary" v-close-popup/>
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script>
import {readLocalStorage, writeLocalStorage} from "src/utils/storage";
import global from "src/utils/hypergryphConnect";
import {Notify} from "quasar";

export default {
  name: "TokenManager",
  data: () => ({
    dialog: false,
    officialToken: [],
    officialTempToken: '',
    officialInfoLoading: false,
    officialTempInfo: {},
    bilibiliToken: [],
    bilibiliTempToken: '',
    bilibiliInfoLoading: false,
    bilibiliTempInfo: {},
    summaryDataSet: {},
    rawToken: [],
    jsonDataOfficial: "",
    jsonDataBilibili: "",
    informationUrl: 'https://api.kaltsit.dev/info/u8/user/info/v1/basic',
    showSecret: {},
    current: {},
    officialButton: new Date().getTime(),
    bilibiliButton: new Date().getTime(),
    enableInfoShow: true,
    userInfos: [],
    jsonData: '',
    syncLoading: false,
  }),
  methods: {
    onDialogClick() {
      this.dialog = true;
    },
    async loadTokens() {
      let tokens = await readLocalStorage('tokens');
      this.userInfos = tokens ? tokens : [];
      this.summaryDataSet = await readLocalStorage('SummaryDataSet');
      if (!this.summaryDataSet)
        this.summaryDataSet = {};
      this.current = await readLocalStorage('active');
      if (!this.current)
        this.current = {};
      this.showSecret = {};
      if (tokens != null) {
        this.rawToken = tokens;
        tokens.forEach(element => {
          if (element.type === 'official') {
            this.officialToken.push(element);
          } else if (element.type === 'bilibili') {
            this.bilibiliToken.push(element);
          }
          this.showSecret[element.info.uid] = false;
        });
      } else {
        this.dialog = true;
      }
    },
    async syncData(userInfo) {
      await global.background.updateSpecify(
        userInfo,
        (message) => Notify.create({message: message, color: 'positive', position: 'top', timeout: 2000}),
        false,
        (percentage, create = false, title = '') => {
          return this.$q.notify({group: false, timeout: 0, spinner: true, message: title, caption: '0%', position: 'center', type: 'info'});
        }
      );
    },
    async saveTokens(userInfo) {
      let exist = false;
      for (let i = 0; i < this.userInfos.length; i++) {
        if (this.userInfos[i].info.uid === userInfo.info.uid) {
          this.userInfos[i] = userInfo;
          exist = true;
          this.$q.notify({
            color: 'positive',
            message: 'uid已存在，token已更新',
            position: 'bottom',
          });
          break;
        }
      }
      if (!exist)
        this.userInfos.push(userInfo);
      await writeLocalStorage('tokens', this.userInfos);
      this.showSecret[userInfo.info.uid] = false;
      if (this.userInfos.length === 1)
        await this.active(this.userInfos[0]);
      await this.syncData(userInfo);
    },
    async onJsonChange(jsonStr) {
      try {
        let requestData = {appId: 1, channelMasterId: 1, channelToken: {token: null}};
        let userInfo = {type: '', info: {}, token: '', active: false,};
        let json = JSON.parse(jsonStr);
        if (json.hasOwnProperty('data')) {
          if (json.data.hasOwnProperty('token')) {
            let token = json.data.token;
            userInfo.type = 'official';
            userInfo.token = token;
            requestData = {appId: 1, channelMasterId: 1, channelToken: {token: token}};
          } else if (json.data.hasOwnProperty('content')) {
            let token = json.data.content;
            userInfo.type = 'bilibili';
            userInfo.token = token;
            requestData = {token: token};
          } else {
            return false;
          }
          let result = await this.getInfo(requestData);
          if (result.status === 0) {
            userInfo.info = result.data;
            await this.saveTokens(userInfo);
          } else {
            this.$q.notify({
              color: 'negative',
              message: 'token失效，请检查',
              position: 'bottom',
            });
          }
        }
      } catch (e) {
        this.$q.notify({
          color: 'warning',
          message: '数据结构错误，请重新复制全部',
          position: 'bottom',
        });
      }
    },
    async saveOfficialTokens() {
      if (this.checkOfficialTokenJson(this.jsonDataOfficial) && this.officialTempInfo.status !== 0) {
        this.officialInfoLoading = true;
        this.officialTempInfo = await this.getInfo(this.officialTempToken);
        this.officialInfoLoading = false;
      }
      if (this.officialTempInfo.status === 0) {
        let exist = false;
        let userInfo = {
          type: 'official',
          token: this.officialTempToken,
          info: this.officialTempInfo.data,
          active: false,
        }
        for (let i = 0; i < this.officialToken.length; i++) {
          if (this.officialToken[i].info.uid === this.officialTempInfo.data.uid) {
            this.officialToken[i].info = this.officialTempInfo.data;
            this.officialToken[i].token = this.officialTempToken;
            this.$q.notify({
              color: 'positive',
              message: 'uid已存在，token已更新',
              position: 'bottom',
            });
            exist = true;
          }
        }
        if (!exist)
          this.officialToken.push(userInfo);
        this.rawToken = this.officialToken.concat(this.bilibiliToken);
        await writeLocalStorage('tokens', this.rawToken);
        this.showSecret[userInfo.info.uid] = false;
        await global.background.updateSpecify(userInfo, (message) => Notify.create({message: message, color: 'positive', position: 'top', timeout: 2000}), false);
        this.officialTempInfo = {};
        if (this.rawToken.length === 1)
          await this.active(this.rawToken[0]);
        return;
      }
      this.$q.notify({
        color: 'red',
        textColor: 'white',
        message: '请检查你的token是否正确',
        position: 'bottom',
        timeout: 2000,
      });
    },
    async saveBilibiliTokens() {
      if (this.checkBilibiliTokenJson(this.jsonDataBilibili) && this.bilibiliTempInfo.status !== 0) {
        this.bilibiliInfoLoading = true;
        this.bilibiliTempInfo = await this.getInfo(this.bilibiliTempToken);
        this.bilibiliInfoLoading = false;
      }
      if (this.bilibiliTempInfo.status === 0) {
        let exist = false;
        let userInfo = {
          type: 'bilibili',
          token: this.bilibiliTempToken,
          info: this.bilibiliTempInfo.data,
          active: false,
        };
        for (let i = 0; i < this.bilibiliToken.length; i++) {
          if (this.bilibiliToken[i].info.uid === this.bilibiliTempInfo.data.uid) {
            this.bilibiliToken[i].info = this.bilibiliTempInfo.data;
            this.bilibiliToken[i].token = this.bilibiliTempToken;
            this.$q.notify({
              color: 'positive',
              message: 'uid已存在，token已更新',
              position: 'bottom',
            });
            exist = true;
          }
        }
        if (!exist)
          this.bilibiliToken.push(userInfo);
        this.rawToken = this.bilibiliToken.concat(this.bilibiliToken);
        await writeLocalStorage('tokens', this.rawToken);
        this.showSecret[userInfo.info.uid] = false;
        await global.background.updateSpecify(userInfo, (message) => Notify.create({message: message, color: 'positive', position: 'top', timeout: 2000}), false);
        this.bilibiliTempInfo = {};
        if (this.rawToken.length === 1)
          await this.active(this.rawToken[0]);
        return;
      }
      this.$q.notify({
        color: 'red',
        textColor: 'white',
        message: '请检查你的token是否正确',
        position: 'bottom',
        timeout: 2000,
      });
    },
    getUidList(array) {
      let uidList = [];
      array.forEach(element => uidList.push(element.info.uid));
      return uidList;
    },
    checkTokenJson(jsonStr) {
      try {
        let object = JSON.parse(jsonStr);
        if (object.status === 0 || object.code === 0)
          if (object.hasOwnProperty('data'))
            if (object.data.hasOwnProperty('token') || object.data.hasOwnProperty('content'))
              return true;
      } catch {
      }
      return false;
    },
    checkOfficialTokenJson(jsonStr) {
      try {
        let object = JSON.parse(jsonStr);
        if (object.status === 0) {
          let token = object.data.token;
          if (token != null) {
            this.officialTempToken = token;
            return true;
          }
        }
      } catch {
      }
      return false;
    },
    checkBilibiliTokenJson(jsonStr) {
      try {
        let object = JSON.parse(jsonStr);
        if (object.code === 0) {
          let token = object.data.content;
          if (token != null) {
            this.bilibiliTempToken = token;
            return true;
          }
        }
      } catch {
      }
      return false;
    },
    async active(item) {
      this.userInfos.forEach(element => element.active = element.info.uid === item.info.uid);
      this.rawToken = this.officialToken.concat(this.bilibiliToken);
      await writeLocalStorage('tokens', this.rawToken);
      await writeLocalStorage('active', item);
      this.onActive();
    },
    secretString(srcStr) {
      let result = '';
      for (let i = 0; i < srcStr.length; i++)
        result += '*';
      return result;
    },
    async httpPost(url, data) {
      return await fetch(url, {method: 'POST', body: JSON.stringify(data), mode: 'cors'});
    },
    async getInfo(requestData) {
      let response = await this.httpPost(this.informationUrl, requestData);
      return response.json();
    }
  },
  async mounted() {
    await this.loadTokens();
  },
  watch: {
    async jsonDataOfficial(newValue) {
      this.officialInfoLoading = true;
      let result = this.checkOfficialTokenJson(newValue);
      if (result) {
        this.officialTempInfo = {};
        let requestData = {appId: 1, channelMasterId: 1, channelToken: {token: this.officialTempToken}};
        this.officialTempInfo = await this.getInfo(requestData);
      }
      this.officialButton = new Date().getTime();
      this.officialInfoLoading = false;
    },
    async jsonDataBilibili(newValue) {
      this.bilibiliInfoLoading = true;
      let result = this.checkBilibiliTokenJson(newValue);
      if (result) {
        this.bilibiliTempInfo = {};
        let requestData = {token: this.bilibiliTempToken};
        this.bilibiliTempInfo = await this.getInfo(requestData);
      }
      this.bilibiliButton = new Date().getTime();
      this.bilibiliInfoLoading = false;
    },
    async jsonData(newValue) {
      this.syncLoading = true;
      await this.onJsonChange(newValue);
      this.syncLoading = false;
    }
  },
  props: {
    'onActive': {
      type: Function,
      required: true,
    },
  }
}
</script>

<style scoped>

</style>
