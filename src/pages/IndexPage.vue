<template>
  <q-page class="-primary mainBody " :class="$q.screen.gt.sm ? 'flex flex-center': ''">
    <div class="row" :style="$q.screen.gt.sm ? 'width: 65%': ''" :class="$q.screen.gt.sm ? '':'q-px-md'">
      <div class="col-12">
        <div class="col q-pa-sm" style="margin-bottom: 20px;">
          <div class="text-h3 vertical-middle	">ArkRecord
            <q-badge color="primary">{{ version }}</q-badge>
            <author-message/>
            <settingManager css="float-right"/>
          </div>

          <div class="text-caption vertical-middle"> ArkRecord 不会收集上传你的任何信息数据，所有从鹰角网站获取的数据都只会保存在本地。</div>
        </div>
        <tokenManager :on-active="onActive"/>
        <div class="q-gutter-sm">
          <q-badge color="blue" v-if="usageInfo.total >= 0">使用者: {{ usageInfo.total }} 个</q-badge>
          <q-badge color="blue" v-if="usageInfo.day180 >= 0">半年内活跃使用者: {{ usageInfo.day180 }} 个</q-badge>
          <q-badge color="blue" v-if="usageInfo.day30 >= 0">一个月内活跃使用者: {{ usageInfo.day30 }} 个</q-badge>
        </div>
        <div class="col q-py-sm" style="">
          <q-btn-toggle style="opacity: .75" spread no-caps
                        v-model="shownMode" :options="showOptions" class="my-custom-toggle" toggle-color="primary" color="white" text-color="primary"/>
        </div>
        <div class="col" style="" :key="containerKey">
          <poolsTable v-if="shownMode === '1'" :bilibili="bilibili" :key="tabKeys[parseInt(shownMode)]"></poolsTable>
          <totalTable v-if="shownMode === '2'" :bilibili="bilibili" :key="tabKeys[parseInt(shownMode)]"></totalTable>
          <normalSplitTable v-if="shownMode === '3'" :bilibili="bilibili" :key="tabKeys[parseInt(shownMode)]"></normalSplitTable>
          <chartShow v-if="shownMode === '4'" :bilibili="bilibili" :key="tabKeys[parseInt(shownMode)]"></chartShow>
          <statisticsAnalyze v-if="shownMode === '5'" :bilibili="bilibili" :key="tabKeys[parseInt(shownMode)]"></statisticsAnalyze>
          <stoneAndRecharge v-if="shownMode === '6'" :bilibili="bilibili" :key="tabKeys[parseInt(shownMode)]"/>
        </div>
        <div class="col" style="margin-bottom: 20px; ">
          <screen-shot></screen-shot>
          <data-manager :dataUpdated="dataUpdated" @update:dataUpdated="dataUpdated = $event" :bilibili="bilibili"/>
          <information-set/>
        </div>
      </div>
      <q-page-scroller position="bottom-right" :scroll-offset="150" :offset="[18, 18]">
        <q-btn fab icon="keyboard_arrow_up" color="secondary"/>
      </q-page-scroller>
      <q-page-scroller reverse position="top-left" :scroll-offset="20" :offset="[18, 18]">
        <q-btn fab icon="keyboard_arrow_down" color="primary"/>
      </q-page-scroller>
    </div>
  </q-page>
  <!-- Notice lang="sass" -->

</template>

<script>
import config from '../../package.json';
import {loadPools} from '../utils/data';
import {readLocalStorage, writeLocalStorage} from '../utils/storage';
import {defineComponent} from "vue";
import {Statistic} from "../utils/Usage";
import ChartShow from "components/tabs/ChartShow.vue";
import PoolsTable from "components/tabs/PoolsTable.vue";
import TotalTable from "components/tabs/TotalTable.vue";
import NormalSplitTable from "components/tabs/NormalSplitTable.vue";
import StatisticsAnalyze from "components/tabs/StatisticsAnalyze.vue";
import ScreenShot from "components/functional/ScreenShot.vue";
import DataManager from "components/functional/DataManager.vue";
import InformationSet from "components/functional/InformationSet.vue";
import StoneAndRecharge from "components/tabs/StoneAndRecharge.vue";
import SettingManager from "components/SettingManager.vue";
import AuthorMessage from "components/functional/AuthorMessage.vue";
import TokenManager from "components/functional/TokenManager.vue";

export default defineComponent({
  name: "IndexPage",
  components: {
    chartShow: ChartShow,
    poolsTable: PoolsTable,
    totalTable: TotalTable,
    normalSplitTable: NormalSplitTable,
    statisticsAnalyze: StatisticsAnalyze,
    screenShot: ScreenShot,
    dataManager: DataManager,
    informationSet: InformationSet,
    stoneAndRecharge: StoneAndRecharge,
    settingManager: SettingManager,
    authorMessage: AuthorMessage,
    tokenManager: TokenManager,
  },
  data: () => ({
    version: config.version,
    pools: [],
    poolsDict: {},
    shownMode: "1",
    showOptions: [{label: '卡池分类', value: '1'}, {label: '有限选择', value: '2'}, {label: '纯常驻寻访', value: '3'},
      {label: '图表', value: '4'}, {label: '统计学分析', value: '5'}, {label: '源石&充值记录', value: '6'}],
    bilibili: false,
    login: false,
    loginB: false,
    containerKey: new Date().getTime(),
    dataUpdated: new Date().getTime(),
    tabKeys: [],
    usageInfo: {
      total: -1,
      day180: -1,
      day30: -1,
    },
  }),
  methods: {
    async loadData() {
    },
    async loginCheck() {
      let login = await readLocalStorage("login");
      let loginB = await readLocalStorage("loginB");
      this.login = login;
      this.loginB = loginB;
      if (loginB && !login)
        this.bilibili = true;
    },
    async onActive() {
      this.tabKeys[parseInt(this.shownMode)] = new Date().getTime();
    },
    async syncUsageInfo() {
      let statistic = new Statistic();
      await statistic.syncData();
      this.usageInfo = {
        total: statistic.activeTotal,
        day30: statistic.activeDay30,
        day180: statistic.activeDay180
      };
    }
  },
  watch: {
    bilibili: function () {
      // this.loadData();
      this.containerKey = new Date().getTime();
    },
    dataUpdated: function () {
      // console.log("Data Updated");
      // console.log(this);
      // this.loadData();
      // this.containerKey = new Date().getTime();
    }
  },
  mounted() {
    this.syncUsageInfo();
    this.tabKeys = [];
    for (let i = 0; i < this.showOptions.length; i++) {
      this.tabKeys.push(new Date().getTime());
    }
    this.loginCheck()
    this.loadData()
    writeLocalStorage("indexVisited", true);
  }
})
</script>

<style>
</style>
