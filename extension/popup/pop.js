import { v4 as uuidv4 } from 'uuid';

//Buttons
const TranslateButton = document.getElementById("Translate-Id");
const language = document.getElementById("language-Id");

TranslateButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if(!tab){
    console.log("No Tabs Opened");
    return;
  }

  let imageSrcs =[];
  try {
    const images = await chrome.scripting.executeScript({ //gets images from the active tab
      target: {tabId: tab.id},
      func: () => Array.from(document.images).map(img => img.src)
    });
    imageSrcs = (images[0] && images[0].result) || []; //get the images Urls
  } catch(e){
    console.error("Failed to retrieve image URLs", e);
    return;
  }
  
  if(imageSrcs.length === 0){
    console.log("No images found on the page");
    return;
  } 

  try{
    await translateImage(imageSrcs, language.value);
  } catch(e){
    console.error("Failed to translate images", e);
  }


});

async function translateImage(imageSrcs, language) {
  const CHUNK = 10;
  for (let start = 0; start < imageSrcs.length; start += CHUNK) { //makes sure to send in batches of 10
    const formData = new FormData();
    formData.append("language", language);

    const slice = imageSrcs.slice(start, start + CHUNK);
    const fetched = await Promise.all(slice.map(async (url, i) => { //getting arrays of boolean values
      try{
        const res = await fetch(url); //get url
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob(); // gets blob

        const clean = url.split(/[?#]/)[0]; //remove query params
        const lastDot = clean.lastIndexOf(".");
        let ext = lastDot !== -1 ? clean.slice(lastDot + 1).toLowerCase() : "png";
        if (!/^[a-z0-9]{2,5}$/.test(ext)) ext = "png";

        formData.append(`images`, blob, `image.${start + i}.${ext}`); //added blob
        formData.append('session_id', session_id); //added session ID
        return true;
      } catch (error) {
        console.error("Error fetching image:", error);
        return false;
      }
    }));

    if(!fetched.some(Boolean)){
      console.error("No Images fetched Successfully.");
      continue;
    }
    try {
      const ocrResponse = await fetch(`http://3.144.33.148/ocr`, { //fetches the backend
        method: "POST",// sending to backend
        headers: { 'Authorization': 'kibutsiki'},
        body: formData //data
      });
      if(!ocrResponse.ok) throw new Error(`HTTP ${ocrResponse.status}`);
      const ocrData = await ocrResponse.json(); //returned data
      ocrData.results.forEach(result => {
        console.log("OCR Result:", result);
      }); 
      const translateResponse = await fetch('http://3.144.33.148/translate', {
        method: "POST",
        headers: { 'Authorization': 'kibutsiki'},
        body: formData
      });
      const translateData = await translateResponse.json();
      translateData.results.forEach(result => {
        console.log("Translate Result:", result);
      });
    } catch (e) {
      console.error("Error sending to Backend:", e);
    }
  }
}