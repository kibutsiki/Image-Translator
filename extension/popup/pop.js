const session_id = uuid.v4();

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
  for (let start = 0; start < imageSrcs.length; start++) { //makes sure to send in batches of 10
    
    const body = JSON.stringify({
      imageSrcs: imageSrcs[start],
      language,
      session_id
    });
    
    try {
      const ocrResponse = await fetch(`http://3.17.59.119/ocr`, { //fetches the backend
        method: "POST",// sending to backend
        headers: { 'Authorization': 'kibutsiki',
          'Content-Type': 'application/json'
        },
        body: body //data
      });

      //handles errors ocr
      if(!ocrResponse.ok) throw new Error(`HTTP ${ocrResponse.status}`);
      const ocrData = await ocrResponse.json(); //returned data
      ocrData.results.forEach(result => {
        console.log("OCR Result:", result);
      });


      //translate 
      const translateResponse = await fetch(`http://3.17.59.119/translate`, {
        method: "POST",
        headers: { 'Authorization': 'kibutsiki',
             'Content-Type': 'application/json'
        },
        body: body
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