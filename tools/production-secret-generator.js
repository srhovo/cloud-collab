'use strict';

const state = new Map();
const rows = document.getElementById('valueRows');
const publicOrigin = document.getElementById('publicOrigin');
const adminOrigin = document.getElementById('adminOrigin');
const envBlock = document.getElementById('envBlock');
const copyAll = document.getElementById('copyAll');
const status = document.getElementById('status');

window.PRODUCTION_GENERATOR_READY = false;
