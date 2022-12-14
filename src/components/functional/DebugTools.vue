<template>
  <q-btn class="q-px-md" color="primary" label="刷新数据" @click="loadData"/>
  <q-table
    :title="'数据('+ totalSizeStr+')'"
    :rows="rows"
    :columns="columns"
    row-key="name"
    :pagination="initialPagination"
    style="background-color:rgba(255,255,255, 0.5); margin-top: 20px"
  >

    <template v-slot:header="props">
      <q-tr :props="props">
        <q-th auto-width/>
        <q-th
          v-for="col in props.cols"
          :key="col.name"
          :props="props"
        >
          {{ col.label }}
        </q-th>
      </q-tr>
    </template>

    <template v-slot:body="props">
      <q-tr :props="props">
        <q-td auto-width>
          <q-btn size="sm" color="accent" round dense @click="props.row.show = !props.row.show" :icon="props.row.show ? 'remove' : 'add'"/>
        </q-td>
        <q-td
          v-for="col in props.cols"
          :key="col.name"
          :props="props"
        >
          {{ col.value }}
        </q-td>
      </q-tr>
      <q-tr v-show="props.row.show" :props="props">
        <q-td colspan="100%">
          <div class="row">
            <div class="col-2"></div>
            <div class="col-10 text-left">
              <json-viewer :value="props.row.data " :expand-depth=3 style="background-color:rgba(0,0,0,0)"></json-viewer>
            </div>
          </div>
        </q-td>
      </q-tr>
    </template>

  </q-table>
</template>

<script>
import {readAllLocalStorage} from "src/utils/storage";
import JsonViewer from 'vue-json-viewer'

export default {
  name: "DebugTools",
  components: {
    JsonViewer
  },
  data: () => ({
    data: {},
    shownData: [],
    columns: [
      {name: 'key', align: 'center', label: 'key', field: 'key', sortable: true},
      {name: 'value', align: 'center', label: 'value', field: 'value', sortable: true},
      {name: 'size', align: 'center', label: 'size', field: 'size', sortable: true},
    ],
    rows: [],
    initialPagination: {
      sortBy: 'desc',
      descending: false,
      page: 1,
      rowsPerPage: 100
    },
    totalData: {},
    totalDataString: [],
    totalSize: 0,
    totalSizeStr: '0 Bytes',
  }),
  methods: {
    async loadData() {
      let rawData = await readAllLocalStorage();
      this.data = rawData;
      this.rows = [];
      this.shownData = [];
      Object.keys(rawData).forEach(key => {
        let data = JSON.stringify(rawData[key]);
        this.shownData.push({
          key: key,
          value: data
        });
        this.rows.push({
          key: key,
          value: data.length > 80 ? data.substring(0, 80) : data,
          data: rawData[key],
          show: false,
          size: this.sizeToString(data.length)
        });
      });
      this.totalData = rawData;
      this.totalDataString = JSON.stringify(rawData);
      this.totalSize = this.totalDataString.length;
      this.totalSizeStr = this.sizeToString(this.totalSize);
    },
    buildTree(dict, rootNode) {
      Object.keys(dict).forEach(key => {
        let node = {
          label: typeof dict[key] === 'object' ? key : JSON.stringify({key: dict[key]}),
          children: []
        };
        rootNode.children.push(node);
        if (typeof dict[key] === 'object') {
          this.buildTree(dict[key], node);
        }
      });
    },
    sizeToString(size) {
      let unit = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      while (size > 1024) {
        size /= 1024;
        i++;
      }
      return size.toFixed(2) + ' ' + unit[i];
    }
  },
  async mounted() {
    await this.loadData();
  }
}
</script>

<style scoped>

</style>
