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
  const formData = new FormData();
  formData.append("language", language);

  const fetched = await Promise.all(imageSrcs.map(async (url, idx) => { //trying to get images to blobs
    try{
      const res = await fetch(url);
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();

      const clean = url.split(/[?#]/)[0];
      const lastDot = clean.lastIndexOf(".");
      let ext = lastDot !== -1 ? clean.slice(lastDot + 1).toLowerCase() : "png";
      if (!/^[a-z0-9]{2,5}$/.test(ext)) ext = "png";

      formData.append(`images[${idx}]`, blob, `image.${ext}`);
      return true;
    } catch (error) {
      console.error("Error fetching image:", error);
      return false;
    }
  }));

  if(!fetched.some(ok => ok)){
    console.error("No Images fetched Successfully.");
    return;
  }


  //send to backend
}