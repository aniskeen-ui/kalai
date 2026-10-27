const K='stubdb';
export const db={get(){try{return JSON.parse(localStorage.getItem(K))||{users:{},items:[],session:null}}catch{return{users:{},items:[],session:null}}},set(v){localStorage.setItem(K,JSON.stringify(v))}};
