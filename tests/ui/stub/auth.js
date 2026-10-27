import {db} from './store.js';
const err=(n)=>{const e=new Error(n);e.name=n;return e};
export async function signUp({username,password}){const d=db.get();if(d.users[username])throw err('UsernameExistsException');d.users[username]={password,confirmed:false,groups:username.startsWith('admin')?['ADMINS']:[]};db.set(d);return{nextStep:{signUpStep:'CONFIRM_SIGN_UP'}}}
export async function confirmSignUp({username,confirmationCode}){if(confirmationCode!=='123456')throw err('CodeMismatchException');const d=db.get();d.users[username].confirmed=true;d.pending=username;db.set(d);return{nextStep:{signUpStep:'COMPLETE_AUTO_SIGN_IN'}}}
export async function autoSignIn(){const d=db.get();d.session=d.pending;db.set(d);return{nextStep:{signInStep:'DONE'}}}
export async function resendSignUpCode(){}
export async function signIn({username,password}){const d=db.get();const u=d.users[username];if(!u||u.password!==password)throw err('NotAuthorizedException');if(!u.confirmed)return{nextStep:{signInStep:'CONFIRM_SIGN_UP'}};d.session=username;db.set(d);return{nextStep:{signInStep:'DONE'}}}
export async function signOut(){const d=db.get();d.session=null;db.set(d)}
export async function getCurrentUser(){const d=db.get();if(!d.session)throw err('UserUnAuthenticatedException');return{username:d.session,userId:d.session,signInDetails:{loginId:d.session}}}
export async function fetchUserAttributes(){const d=db.get();return{email:d.session}}
export async function fetchAuthSession(){const d=db.get();return{tokens:{accessToken:{payload:{'cognito:groups':d.users[d.session]?.groups||[]}}}}}
export async function resetPassword(){return{}}
export async function confirmResetPassword(){}
