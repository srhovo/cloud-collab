import {
  handleSensitiveReviewApproveRequest as handlePreviewApprove,
  handleSensitiveReviewDetailRequest as handlePreviewDetail,
  handleSensitiveReviewEditAndApproveRequest as handlePreviewEditAndApprove,
  handleSensitiveReviewListRequest as handlePreviewList,
  handleSensitiveReviewRejectRequest as handlePreviewReject,
} from './admin_sensitive_review_http_v1.js';
import {
  handleProductionSensitiveReviewApproveRequest,
  handleProductionSensitiveReviewDetailRequest,
  handleProductionSensitiveReviewEditAndApproveRequest,
  handleProductionSensitiveReviewListRequest,
  handleProductionSensitiveReviewRejectRequest,
} from './production_admin_sensitive_review_http_v1.js';
function productionFlag(env={}){const raw=String(env.CLOUD_PRODUCTION_ENABLED??'').trim();if(raw==='1')return true;if(raw===''||raw==='0')return false;return null;}
function invalidFlagResponse(){return new Response(JSON.stringify({ok:false,serviceId:'cloud-collab-admin-sensitive-dispatch',apiVersion:'2026-07-21-stage7t',error:{code:'PRODUCTION_FLAG_INVALID',message:'敏感审核服务配置无效'}}),{status:503,headers:{'Cache-Control':'no-store','Content-Type':'application/json; charset=UTF-8','X-Content-Type-Options':'nosniff'}});}
function dispatch(context,dependencies,productionHandler,previewHandler){const production=productionFlag(context?.env||{});if(production===null)return invalidFlagResponse();return production?productionHandler(context,dependencies.production||dependencies):previewHandler(context,dependencies.preview||dependencies);}
export function dispatchSensitiveReviewListRequest(context,dependencies={}){return dispatch(context,dependencies,handleProductionSensitiveReviewListRequest,handlePreviewList);}
export function dispatchSensitiveReviewDetailRequest(context,dependencies={}){return dispatch(context,dependencies,handleProductionSensitiveReviewDetailRequest,handlePreviewDetail);}
export function dispatchSensitiveReviewApproveRequest(context,dependencies={}){return dispatch(context,dependencies,handleProductionSensitiveReviewApproveRequest,handlePreviewApprove);}
export function dispatchSensitiveReviewRejectRequest(context,dependencies={}){return dispatch(context,dependencies,handleProductionSensitiveReviewRejectRequest,handlePreviewReject);}
export function dispatchSensitiveReviewEditAndApproveRequest(context,dependencies={}){return dispatch(context,dependencies,handleProductionSensitiveReviewEditAndApproveRequest,handlePreviewEditAndApprove);}
